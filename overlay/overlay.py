#!/usr/bin/env python3
"""Плавающее окно с остатком лимитов Claude.

Запускается MCP-сервером расширения, поэтому живёт ровно столько же, сколько
Claude Desktop: данные приходят строками JSON в stdin, а закрытие stdin
(приложение вышло) завершает окно. Разбор истории целиком на стороне сервера —
здесь только показ и позиционирование.
"""

import json
import os
import shutil
import signal
import subprocess
import sys
import threading

# Имя не должно содержать "claude": иначе поиск окна Claude находит нас самих.
APP_CLASS = "limits-overlay"
MARGIN = 14


def emit(payload):
    """Сообщение серверу расширения. Только stdout, по строке на событие."""
    try:
        sys.stdout.write(json.dumps(payload) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def log(message):
    sys.stderr.write("[overlay] %s\n" % message)
    sys.stderr.flush()


try:
    import gi

    gi.require_version("Gtk", "3.0")
    gi.require_version("Gdk", "3.0")
    from gi.repository import Gtk, Gdk, GLib

    webkit_version = None
    for candidate in ("4.1", "4.0", "6.0", "5.0"):
        try:
            gi.require_version("WebKit2", candidate)
            from gi.repository import WebKit2

            webkit_version = candidate
            break
        except (ValueError, ImportError):
            continue
    if webkit_version is None:
        raise ImportError("WebKit2GTK was not found")
except Exception as error:  # noqa: BLE001 - сообщаем серверу и выходим
    emit({"type": "unavailable", "message": str(error)})
    log("GTK/WebKit unavailable: %s" % error)
    sys.exit(3)



def acquire_lock(path):
    """Одна панель на систему.

    Claude Desktop может поднять MCP-сервер не один раз (например, отдельным
    процессом для перечисления инструментов), и тогда окон становится два: они
    дерутся за одну позицию, мигают и заваливают X-сервер запросами.
    """
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
    except Exception:
        pass
    try:
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as handle:
                other = int((handle.read() or "0").strip() or 0)
            if other and other != os.getpid():
                try:
                    os.kill(other, 0)
                except (ProcessLookupError, ValueError):
                    pass          # процесс мёртв, замок протух
                except PermissionError:
                    return False  # живой чужой процесс
                else:
                    return False
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(str(os.getpid()))
        return True
    except Exception:
        return True  # замок не критичен: лучше показать окно, чем не показать


def release_lock(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            if int((handle.read() or "0").strip() or 0) == os.getpid():
                os.unlink(path)
    except Exception:
        pass


class WindowTracker:
    """Ищет окно Claude Desktop, чтобы прижать панель к его углу.

    Запуск xdotool на каждый тик — это по несколько процессов в секунду и
    поток запросов к X-серверу. Поэтому найденный идентификатор кэшируется, а
    полный поиск повторяется редко и только когда окно потерялось.
    """

    SEARCH_EVERY = 10          # тиков между полными поисками
    FAILURE_LIMIT = 6          # после стольких сбоев подряд слежение отключается

    def __init__(self):
        self.xdotool = shutil.which("xdotool")
        self.self_id = None
        self.window_id = None
        self.ticks_since_search = self.SEARCH_EVERY
        self.failures = 0
        self.disabled = False
        self.last = None

    def available(self):
        return bool(self.xdotool) and not self.disabled

    def exclude(self, window_id):
        """XID собственного окна, чтобы не принять себя за окно Claude."""
        self.self_id = str(window_id) if window_id else None

    def _run(self, args):
        return subprocess.run(
            [self.xdotool] + args, capture_output=True, text=True, timeout=3,
        )

    def _geometry(self, window_id):
        try:
            result = self._run(["getwindowgeometry", "--shell", str(window_id)])
            if result.returncode != 0:
                return None
            values = {}
            for line in result.stdout.splitlines():
                if "=" in line:
                    key, _, value = line.partition("=")
                    values[key.strip()] = value.strip()
            return (
                int(values["X"]), int(values["Y"]),
                int(values["WIDTH"]), int(values["HEIGHT"]),
            )
        except Exception:
            return None

    def _search(self):
        # xdotool --class матчит второе поле WM_CLASS, --classname первое:
        # у разных сборок Claude Desktop имя лежит то там, то там.
        ids = []
        for flag in ("--class", "--classname"):
            try:
                found = self._run(["search", "--onlyvisible", flag, "claude"])
            except Exception:
                continue
            for line in found.stdout.splitlines():
                line = line.strip()
                if line and line not in ids:
                    ids.append(line)
        if not ids:
            return None
        best_id, best = None, None
        for window_id in ids:
            if self.self_id and window_id == self.self_id:
                continue
            geometry = self._geometry(window_id)
            if not geometry or geometry[2] < 200 or geometry[3] < 200:
                continue
            if best is None or geometry[2] * geometry[3] > best[2] * best[3]:
                best_id, best = window_id, geometry
        return (best_id, best) if best_id else None

    def claude_geometry(self):
        if not self.available():
            return None
        try:
            # Обычный тик: одна проверка геометрии уже известного окна.
            if self.window_id is not None and self.ticks_since_search < self.SEARCH_EVERY:
                self.ticks_since_search += 1
                geometry = self._geometry(self.window_id)
                if geometry and geometry[2] >= 200 and geometry[3] >= 200:
                    self.failures = 0
                    return self._remember(geometry)
                self.window_id = None  # окно исчезло — нужен новый поиск

            self.ticks_since_search = 0
            result = self._search()
            if result is None:
                self.failures += 1
                if self.failures >= self.FAILURE_LIMIT and not self.xdotool:
                    self.disabled = True
                return None
            self.failures = 0
            self.window_id, geometry = result
            return self._remember(geometry)
        except Exception as error:
            self.failures += 1
            if self.failures >= self.FAILURE_LIMIT:
                self.disabled = True
                log("window tracking disabled after repeated errors: %s" % error)
            return None

    def _remember(self, geometry):
        if geometry != self.last:
            log("Claude window: %s" % (geometry,))
            self.last = geometry
        return geometry


class Overlay:
    def __init__(self, html_path, state):
        self.tracker = WindowTracker()
        self.size = (320, 150)
        self.state = state or {}
        self.last_position = None
        self.follow = True
        self.misses = 0
        self.loaded = False

        # Обычное окно, а не POPUP: POPUP — override-redirect, его не видит
        # оконный менеджер, поэтому keep-above не соблюдается и окно нельзя
        # найти обычными средствами. Рамку убираем сами.
        self.window = Gtk.Window(type=Gtk.WindowType.TOPLEVEL)
        self.window.set_name(APP_CLASS)
        self.window.set_title('Claude limits')
        self.window.set_decorated(False)
        self.window.set_keep_above(True)
        self.window.set_skip_taskbar_hint(True)
        self.window.set_skip_pager_hint(True)
        self.window.set_accept_focus(False)
        # Ресайз разрешён: с set_resizable(False) оконный менеджер игнорирует
        # resize(), и окно навсегда остаётся размером с самый большой стиль —
        # отсюда «размер не меняется» и остатки прошлого вида по краям.
        self.window.set_resizable(True)
        self.window.set_app_paintable(True)
        self.window.set_type_hint(Gdk.WindowTypeHint.UTILITY)
        # Без явного размера GTK выдаёт крошечное окно, и страница,
        # прижатая к правому краю, оказывается обрезанной слева.
        self.window.set_default_size(*self.size)

        screen = self.window.get_screen()
        visual = screen.get_rgba_visual()
        if visual is not None:
            self.window.set_visual(visual)

        manager = WebKit2.UserContentManager()
        manager.register_script_message_handler("overlay")
        manager.connect("script-message-received::overlay", self.on_message)

        self.view = WebKit2.WebView.new_with_user_content_manager(manager)
        self.view.set_background_color(Gdk.RGBA(0, 0, 0, 0))
        settings = self.view.get_settings()
        settings.set_property("enable-developer-extras", False)
        settings.set_property("enable-write-console-messages-to-stdout", False)
        self.view.connect("load-changed", self.on_load)
        # Своё меню по правой кнопке WebKit не нужно: в нём есть «Reload», а
        # перезагрузка выбрасывала страницу на базовый адрес — то есть на
        # список файлов. Гасим меню целиком.
        self.view.connect("context-menu", lambda *_: True)
        # И запрещаем любую навигацию после первой загрузки: ни перетащенный
        # файл, ни ссылка не должны увести окно с панели.
        self.view.connect("decide-policy", self.on_policy)
        self.window.add(self.view)

        with open(html_path, "r", encoding="utf-8") as handle:
            html = handle.read()
        # Без базового file:///, чтобы даже случайная перезагрузка не открыла
        # содержимое файловой системы.
        self.view.load_html(html, None)

        self.window.show_all()
        gdk_window = self.window.get_window()
        if gdk_window is not None:
            try:
                self.tracker.exclude(gdk_window.get_xid())
            except Exception:
                pass
        # Раз в 1,5 с: чаще незачем, а нагрузка на X-сервер заметно ниже.
        GLib.timeout_add(1500, self.reposition)

    # --- мост со страницей -------------------------------------------------

    def on_policy(self, _view, decision, decision_type):
        if decision_type == WebKit2.PolicyDecisionType.NAVIGATION_ACTION and self.loaded:
            decision.ignore()
            return True
        return False

    def on_load(self, _view, event):
        if event == WebKit2.LoadEvent.FINISHED:
            self.loaded = True
            self.push({"type": "settings", "value": self.state})
            emit({"type": "ready", "webkit": webkit_version,
                  "tracking": self.tracker.available()})

    def on_message(self, _manager, result):
        try:
            raw = result.get_js_value().to_string()
            message = json.loads(raw)
        except Exception:
            return
        kind = message.get("type")
        if kind == "size":
            width = max(48, int(message.get("w") or 0))
            height = max(48, int(message.get("h") or 0))
            if (width, height) != self.size:
                self.size = (width, height)
                # set_size_request задаёт минимум и не даёт окну уменьшиться,
                # поэтому минимум держим нулевым, а размер меняем resize().
                self.view.set_size_request(-1, -1)
                self.window.set_size_request(-1, -1)
                self.window.resize(width, height)
                self.window.queue_draw()
                # Позицию пересчитываем после применения размера, иначе окно
                # прижмётся по старым габаритам.
                GLib.idle_add(self.reposition)
        elif kind == "settings":
            self.state = message.get("value") or {}
            emit({"type": "settings", "value": self.state})
        elif kind == "refresh":
            emit({"type": "refresh"})

    def push(self, payload):
        script = "window.__overlay && window.__overlay(%s)" % json.dumps(json.dumps(payload))
        try:
            self.view.evaluate_javascript(script, -1, None, None, None, None, None)
        except AttributeError:
            self.view.run_javascript(script, None, None, None)

    # --- положение ---------------------------------------------------------

    def reposition(self):
        width, height = self.size
        geometry = self.tracker.claude_geometry() if self.follow else None

        if geometry is None:
            # Одиночный промах xdotool — обычное дело; прятать окно сразу
            # значит мигать им. Ждём несколько промахов подряд.
            if self.tracker.available():
                self.misses += 1
                if self.misses >= 3 and self.window.get_visible():
                    self.window.hide()
                return True
            display = Gdk.Display.get_default()
            monitor = display.get_primary_monitor() or display.get_monitor(0)
            area = monitor.get_workarea()
            x = area.x + area.width - width - MARGIN
            y = area.y + area.height - height - MARGIN
        else:
            self.misses = 0
            wx, wy, ww, wh = geometry
            x = wx + ww - width - MARGIN
            y = wy + wh - height - MARGIN

        if not self.window.get_visible():
            self.window.show_all()

        # Сверяемся с фактическим положением, а не с тем, что мы просили.
        # На старте окно ещё не отображено, и move() до этого момента может
        # быть проигнорирован; запомнив позицию, мы больше её не повторяли —
        # окно так и оставалось не в углу до первого изменения размера.
        try:
            actual = self.window.get_position()
        except Exception:
            actual = None
        if actual is None or abs(actual[0] - x) > 1 or abs(actual[1] - y) > 1:
            self.window.move(x, y)
        self.last_position = (x, y)
        # set_keep_above на каждом тике заставляет оконный менеджер
        # перестраивать стопку окон раз в секунду — это и есть мигание.
        return True


def reader(overlay):
    """Строки JSON от MCP-сервера. Конец потока = Claude Desktop закрылся."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except Exception:
            continue
        GLib.idle_add(overlay.push, message)
    GLib.idle_add(Gtk.main_quit)


def watchdog(original_ppid):
    """Если сервер расширения исчез (в том числе убит жёстко), окно уходит с ним.

    Закрытия stdin недостаточно: при SIGKILL родителя поток чтения может
    остаться висеть, поэтому дополнительно следим за сменой PPID.
    """
    if os.getppid() != original_ppid:
        Gtk.main_quit()
        return False
    return True


def main():
    html_path = None
    state = {}
    args = sys.argv[1:]
    for index, arg in enumerate(args):
        if arg == "--html" and index + 1 < len(args):
            html_path = args[index + 1]
        elif arg == "--state" and index + 1 < len(args):
            try:
                state = json.loads(args[index + 1])
            except Exception:
                state = {}
    if not html_path or not os.path.exists(html_path):
        emit({"type": "unavailable", "message": "no HTML path was given"})
        sys.exit(2)

    GLib.set_prgname(APP_CLASS)

    lock_path = os.path.join(
        os.environ.get("CLAUDE_LIMITS_STATE_DIR")
        or os.path.join(os.path.expanduser("~"), ".config", "Claude"),
        "claude-limits-overlay.pid",
    )
    if not acquire_lock(lock_path):
        emit({"type": "duplicate", "message": "the panel is already running in another process"})
        log("the panel is already running - a second instance is not needed")
        sys.exit(0)

    overlay = Overlay(html_path, state)

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        try:
            GLib.unix_signal_add(GLib.PRIORITY_HIGH, sig, lambda: (Gtk.main_quit(), False)[1])
        except Exception:
            signal.signal(sig, lambda *_: Gtk.main_quit())

    GLib.timeout_add(2000, watchdog, os.getppid())
    threading.Thread(target=reader, args=(overlay,), daemon=True).start()
    try:
        Gtk.main()
    finally:
        release_lock(lock_path)


if __name__ == "__main__":
    main()
