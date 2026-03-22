#!/usr/bin/env node
/**
 * pylot-mcp-server.js
 *
 * A standalone MCP (Model Context Protocol) server that bridges AI coding
 * assistants such as Kilocode to the Pylot VS Code extension REPL.
 *
 * Transport: MCP stdio (newline-delimited JSON-RPC 2.0)
 * Dependencies: none (uses Node.js built-ins only)
 *
 * Usage:
 *   node pylot-mcp-server.js [PORT]
 *
 * PORT defaults to 7822 and must match the pylot.mcpServer.port VS Code setting.
 *
 * Configure in Kilocode (settings.json):
 *   "kilo-code.mcpServers": {
 *     "pylot": {
 *       "command": "node",
 *       "args": ["/absolute/path/to/mcp/pylot-mcp-server.js", "7822"],
 *       "disabled": false,
 *       "alwaysAllow": []
 *     }
 *   }
 */

'use strict';

const http = require('http');
const readline = require('readline');

// ── Configuration ────────────────────────────────────────────────────────────

const IPC_PORT = parseInt(process.argv[2] || '7822', 10);
const IPC_HOST = '127.0.0.1';

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
    {
        name: 'pylot_append_and_execute',
        description:
            'Appends Python code to the bottom of the active Python editor and executes it in the persistent Pylot REPL. ' +
            'The REPL is stateful: variables defined in previous calls remain available. ' +
            'Returns the captured stdout/stderr output and a success flag.',
        inputSchema: {
            type: 'object',
            properties: {
                code: {
                    type: 'string',
                    description: 'Python source code to append and execute. May be multi-line.'
                }
            },
            required: ['code']
        }
    },
    {
        name: 'pylot_execute_range',
        description:
            'Executes a range of lines already present in the active Python editor (0-indexed). ' +
            'Useful for re-running an existing section of code without appending new lines.',
        inputSchema: {
            type: 'object',
            properties: {
                startLine: {
                    type: 'integer',
                    description: 'First line to execute (0-indexed, inclusive).'
                },
                endLine: {
                    type: 'integer',
                    description: 'Last line to execute (0-indexed, inclusive).'
                }
            },
            required: ['startLine', 'endLine']
        }
    },
    {
        name: 'pylot_get_status',
        description:
            'Returns the current execution status of the Pylot REPL. ' +
            'Use this to check whether the REPL is ready before sending code, ' +
            'or to poll until a long-running execution completes.',
        inputSchema: {
            type: 'object',
            properties: {},
            required: []
        }
    },
    {
        name: 'pylot_evaluate_expression',
        description:
            'Evaluates a single Python expression in the REPL without appending it to the editor. ' +
            'Returns the string representation, type, shape (for NumPy arrays), and length (for sized objects). ' +
            'Ideal for inspecting variable values without modifying the document.',
        inputSchema: {
            type: 'object',
            properties: {
                expression: {
                    type: 'string',
                    description: 'A valid Python expression (not a statement) to evaluate, e.g. "my_df.shape".'
                }
            },
            required: ['expression']
        }
    },
    {
        name: 'pylot_get_output',
        description:
            'Returns the accumulated stdout/stderr text from the most recent code execution. ' +
            'Call this after pylot_append_and_execute or pylot_execute_range to retrieve all printed output.',
        inputSchema: {
            type: 'object',
            properties: {},
            required: []
        }
    }
];

// ── Tool-to-command mapping ──────────────────────────────────────────────────

const TOOL_COMMAND_MAP = {
    pylot_append_and_execute: 'pylot.agent.appendAndExecute',
    pylot_execute_range:      'pylot.agent.executeRange',
    pylot_get_status:         'pylot.agent.getExecutionStatus',
    pylot_evaluate_expression:'pylot.agent.evaluateExpression',
    pylot_get_output:         'pylot.agent.getOutput'
};

// ── HTTP IPC helper ──────────────────────────────────────────────────────────

/**
 * POST JSON body to the Pylot extension's HTTP IPC server.
 * @param {string} command  VS Code command ID (e.g. 'pylot.agent.appendAndExecute')
 * @param {object} args     Arguments to pass to the command
 * @returns {Promise<any>}  The parsed `result` field from the IPC response
 */
function callPylot(command, args) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ command, args });
        const options = {
            hostname: IPC_HOST,
            port: IPC_PORT,
            path: '/',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) {
                        reject(new Error(parsed.error));
                    } else {
                        resolve(parsed.result);
                    }
                } catch (e) {
                    reject(new Error(`Invalid JSON from IPC server: ${data}`));
                }
            });
        });

        req.on('error', (err) => {
            if (err.code === 'ECONNREFUSED') {
                reject(new Error(
                    `Cannot connect to Pylot IPC server on port ${IPC_PORT}. ` +
                    `Make sure VS Code is open with Pylot active and ` +
                    `pylot.mcpServer.enabled = true in your settings.`
                ));
            } else {
                reject(err);
            }
        });

        req.write(body);
        req.end();
    });
}

// ── MCP protocol helpers ─────────────────────────────────────────────────────

function sendMessage(msg) {
    process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendResult(id, result) {
    sendMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
    sendMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

// ── Message dispatcher ───────────────────────────────────────────────────────

async function handleMessage(msg) {
    const { id, method, params } = msg;

    // Notifications have no id and require no response
    if (id === undefined) {
        return;
    }

    switch (method) {
        case 'initialize':
            sendResult(id, {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'pylot-mcp-server', version: '1.0.0' }
            });
            break;

        case 'tools/list':
            sendResult(id, { tools: TOOLS });
            break;

        case 'tools/call': {
            const toolName = params?.name;
            const toolArgs = params?.arguments || {};
            const command  = TOOL_COMMAND_MAP[toolName];

            if (!command) {
                sendError(id, -32602, `Unknown tool: ${toolName}`);
                break;
            }

            try {
                const result = await callPylot(command, toolArgs);
                // Format the result as a human-readable text block for the AI
                const text = typeof result === 'string'
                    ? result
                    : JSON.stringify(result, null, 2);

                sendResult(id, {
                    content: [{ type: 'text', text }],
                    isError: false
                });
            } catch (err) {
                sendResult(id, {
                    content: [{ type: 'text', text: `Error: ${err.message}` }],
                    isError: true
                });
            }
            break;
        }

        default:
            sendError(id, -32601, `Method not found: ${method}`);
    }
}

// ── Main entry point ─────────────────────────────────────────────────────────

const rl = readline.createInterface({
    input: process.stdin,
    terminal: false
});

rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) { return; }

    let msg;
    try {
        msg = JSON.parse(trimmed);
    } catch (e) {
        // Malformed JSON — send a parse error with null id
        sendMessage({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: `Parse error: ${e.message}` }
        });
        return;
    }

    handleMessage(msg).catch((err) => {
        sendError(msg.id ?? null, -32603, `Internal error: ${err.message}`);
    });
});

rl.on('close', () => {
    process.exit(0);
});

process.stderr.write(
    `[pylot-mcp-server] Started. Connecting to Pylot IPC on http://${IPC_HOST}:${IPC_PORT}\n`
);
