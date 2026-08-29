'use strict';

/*
 * MCP-сервер расширения «Claude Limits».
 * Без внешних зависимостей: JSON-RPC 2.0 поверх stdio.
 */

const fs = require('fs');
const path = require('path');
const sources = require('./sources');
const overlay = require('./overlay');

const NAME = 'claude-limits';
const VERSION = '2.7.0';
const UI_URI = 'ui://claude-limits/panel';
const UI_MIME = 'text/html;profile=mcp-app';
const UI_FILE = path.join(__dirname, '..', 'ui', 'panel.html');

const LABELS = {
  five_hour: '5 hours',
  seven_day: '7 days',
  seven_day_sonnet: 'Sonnet · 7 days',
  seven_day_opus: 'Opus · 7 days',
  seven_day_oauth_apps: 'OAuth apps · 7 days',
  seven_day_cowork: 'Cowork · 7 days',
};

/* ------------------------------------------------------------- транспорт */

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id, result) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function log(message) {
  process.stderr.write(`[claude-limits] ${message}\n`);
}

/* --------------------------------------------------------------- утилиты */

function uiHtml() {
  return fs.readFileSync(UI_FILE, 'utf8');
}

// Подпись для ключа: известная — из таблицы, незнакомая — из самого ключа.
function labelFor(key) {
  if (LABELS[key]) return LABELS[key];
  return String(key).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function labelsFor(limits) {
  const out = {};
  for (const key of Object.keys(limits || {})) out[key] = labelFor(key);
  return out;
}

function summarize(result) {
  if (!result.ok || !result.limits) {
    return 'No local usage data yet. Open the panel — it will read the limits from Claude directly.';
  }
  const lines = [];
  for (const key of sources.orderKeys(result.limits)) {
    const limit = result.limits[key];
    if (!limit || limit.utilization == null) continue;
    const spent = Math.round(limit.utilization);
    const reset = limit.resets_at ? `, resets ${limit.resets_at}` : '';
    lines.push(`${labelFor(key)}: ${spent}% used${reset}`);
  }
  if (!lines.length) return 'This plan does not publish limit windows.';
  const when = result.at ? ` (as of ${result.at}, source: ${result.source})` : '';
  return `Plan usage${when}:\n${lines.join('\n')}`;
}

function overlayPayload() {
  const result = sources.collect();
  const limits = result.limits || {};
  return {
    ok: result.ok,
    source: result.source,
    at: result.at,
    notes: result.notes,
    limits,
    labels: labelsFor(limits),
    order: sources.orderKeys(limits),
  };
}

/* ----------------------------------------------------------------- tools */

const TOOLS = [
  {
    name: 'show_limits',
    title: 'Show limits',
    description: 'Show a panel with current Claude plan usage (5 hours, 7 days, Sonnet/Opus/Cowork).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    _meta: {
      ui: {
        resourceUri: UI_URI,
        visibility: ['model', 'app'],
        preferredSize: { width: 380, height: 320 },
      },
    },
  },
  {
    name: 'get_limits',
    title: 'Limits as text',
    description: 'Return current Claude plan usage as text and JSON, without a panel.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    _meta: { ui: { visibility: ['model', 'app'] } },
  },
  {
    name: 'save_limits',
    title: 'Cache limits',
    description: 'Internal call from the panel: store fresh limit values in the extension cache.',
    inputSchema: {
      type: 'object',
      properties: {
        limits: { type: 'object', description: 'The usage object from the Claude API.' },
        at: { type: 'string', description: 'ISO timestamp of when the data was read.' },
      },
      required: ['limits'],
      additionalProperties: false,
    },
    _meta: { ui: { visibility: ['app'] } },
  },
  {
    name: 'overlay_status',
    title: 'Panel status',
    description: 'Report whether the floating panel is running, and why it is not.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    _meta: { ui: { visibility: ['model'] } },
  },
  {
    name: 'overlay_restart',
    title: 'Restart panel',
    description: 'Restart the floating usage panel, for example after changing settings.',
    inputSchema: {
      type: 'object',
      properties: { off: { type: 'boolean', description: 'Only close the panel, do not start it again.' } },
      additionalProperties: false,
    },
    _meta: { ui: { visibility: ['model'] } },
  },
  {
    name: 'diagnose',
    title: 'Diagnose',
    description: 'Report which local usage data sources are available on this machine.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    _meta: { ui: { visibility: ['model'] } },
  },
];

function callTool(name, args) {
  if (name === 'show_limits' || name === 'get_limits') {
    const result = sources.collect();
    return {
      content: [{ type: 'text', text: summarize(result) }],
      structuredContent: {
        ok: result.ok,
        source: result.source,
        at: result.at,
        notes: result.notes,
        labels: labelsFor(result.limits),
        order: sources.orderKeys(result.limits || {}),
        limits: result.limits || {},
      },
    };
  }

  if (name === 'save_limits') {
    // Панель отдаёт сырой ответ API; приводим его к канону, сохраняем и
    // возвращаем обратно — так нормализация живёт в одном месте.
    const shaped = sources.shape(args && args.limits);
    const at = (args && args.at) || new Date().toISOString();
    const saved = shaped ? sources.writeCache(shaped, at) : false;
    return {
      content: [{ type: 'text', text: saved ? 'Limits stored in the local cache.' : 'Nothing to store.' }],
      structuredContent: {
        saved,
        at,
        limits: shaped || {},
        labels: labelsFor(shaped),
        order: sources.orderKeys(shaped || {}),
      },
    };
  }

  if (name === 'overlay_status') {
    const info = overlay.getStatus();
    return {
      content: [{ type: 'text', text: JSON.stringify(info, null, 2) }],
      structuredContent: info,
    };
  }

  if (name === 'overlay_restart') {
    overlay.stop();
    const info = (args && args.off) ? overlay.getStatus() : overlay.start(overlayPayload, {});
    return {
      content: [{ type: 'text', text: JSON.stringify(info, null, 2) }],
      structuredContent: info,
    };
  }

  if (name === 'diagnose') {
    const info = sources.diagnose();
    info.overlay = overlay.getStatus();
    return {
      content: [{ type: 'text', text: JSON.stringify(info, null, 2) }],
      structuredContent: info,
    };
  }

  return {
    isError: true,
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
  };
}

/* -------------------------------------------------------------- маршруты */

function handle(message) {
  const { id, method, params } = message;

  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false, subscribe: false },
        },
        serverInfo: { name: NAME, version: VERSION },
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;

    case 'ping':
      return reply(id, {});

    case 'tools/list':
      return reply(id, { tools: TOOLS });

    case 'tools/call': {
      const toolName = params && params.name;
      try {
        return reply(id, callTool(toolName, (params && params.arguments) || {}));
      } catch (error) {
        return reply(id, {
          isError: true,
          content: [{ type: 'text', text: `Error in ${toolName}: ${(error && error.message) || error}` }],
        });
      }
    }

    case 'resources/list':
      return reply(id, {
        resources: [{
          uri: UI_URI,
          name: 'claude_limits_panel',
          description: 'Panel showing current Claude plan usage.',
          mimeType: UI_MIME,
          _meta: {
            ui: {
              csp: {
                connectDomains: ['https://claude.ai', 'https://claude.com'],
                resourceDomains: [],
              },
              prefersBorder: true,
              preferredSize: { width: 380, height: 320 },
            },
          },
        }],
      });

    case 'resources/templates/list':
      return reply(id, { resourceTemplates: [] });

    case 'prompts/list':
      return reply(id, { prompts: [] });

    case 'resources/read': {
      const uri = params && params.uri;
      if (uri !== UI_URI) return replyError(id, -32602, `Unknown resource: ${uri}`);
      try {
        return reply(id, { contents: [{ uri: UI_URI, mimeType: UI_MIME, text: uiHtml() }] });
      } catch (error) {
        return replyError(id, -32603, `Could not read the UI resource: ${(error && error.message) || error}`);
      }
    }

    default:
      if (typeof method === 'string' && method.startsWith('notifications/')) return;
      return replyError(id, -32601, `Unsupported method: ${method}`);
  }
}

/* ---------------------------------------------------------------- запуск */

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      log(`skipped malformed line: ${(error && error.message) || error}`);
      continue;
    }
    try {
      handle(message);
    } catch (error) {
      log(`failed to handle ${message && message.method}: ${(error && error.stack) || error}`);
      replyError(message && message.id, -32603, String((error && error.message) || error));
    }
  }
});
// Закрытие stdin означает, что Claude Desktop завершился: гасим окно вместе
// с собой, чтобы панель не пережила приложение.
function shutdown(code) {
  try { overlay.stop(); } catch (_) {}
  process.exit(code || 0);
}
process.stdin.on('end', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('exit', () => { try { overlay.stop(); } catch (_) {} });

log(`server started, version ${VERSION}`);

// Панель поднимается сразу при старте приложения, без вызова из чата.
const overlayFlag = String(process.env.CLAUDE_LIMITS_OVERLAY || '').toLowerCase();
const overlayDisabled = ['off', 'false', '0', 'no'].includes(overlayFlag);
if (!overlayDisabled) {
  try {
    const info = overlay.start(overlayPayload, {});
    log(`panel: ${info.reason}`);
  } catch (error) {
    log(`could not start the panel: ${(error && error.message) || error}`);
  }
} else {
  log('panel disabled by extension settings');
}
