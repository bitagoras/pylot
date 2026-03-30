/**
 * Pylot – Python code runner for VS Code
 *
 * Runs selected Python code in a persistent background REPL. The editor acts
 * as the input interface while results appear in a dedicated output panel.
 * Execution state (running / success / error) is shown via line decorations
 * (left borders).
 *
 * Communication protocol with the REPL wrapper:
 *   The wrapper reads JSON commands from stdin and outputs JSON messages
 *   to stdout, prefixed with the marker <<<PYLOT_JSON>>>.
 *
 *   Message types:
 *     - 'ready': REPL is initialised and ready
 *     - 'input_request': REPL is asking for user input via input()
 *     - 'validate': Result of an async validation check
 *     - 'evaluate_async': Result of an async block evaluation
 *     - 'execute': Result of a standard code execution
 *     - 'interrupt': Result of a keyboard interrupt request
 */

import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';

// ── Types ───────────────────────────────────────────────────────────────────

/** Subset of the Python extension API used for interpreter discovery. */
interface PythonExtensionApi {
    environments: {
        getActiveEnvironmentPath(): { path: string } | undefined;
    };
}

type ExecutionStatus = 'idle' | 'running' | 'succeeded' | 'failed' | 'rejected';

interface ExecutionResult {
    success: boolean;
    executed: boolean;
    status: ExecutionStatus;
}

// ── Module-level state ──────────────────────────────────────────────────────

let pythonRepl: ChildProcess | null = null;
let replReady = false;
let currentPythonPath: string | undefined = undefined;
let currentExecutionCallback: ((success: boolean) => void) | null = null;
let validationCallback: ((isValid: boolean) => void) | null = null;
let outputChannel: vscode.OutputChannel;
let lastExecutionResult: ExecutionResult = { success: false, executed: false, status: 'idle' };
let lastExpressionResult: string = '';
let lastExpressionType: string = '';
let lastExpressionShape: string = '';
let lastExpressionLen: string = '';
let currentPythonVersion: string = '';
let asyncExpressionResultCallback: ((success: boolean, resultText: string, type: string, shape: string, len: string) => void) | null = null;
let debugMode = false;
let mcpDebugMode = false;
let silentEvaluation = false;

/** Tracks the resolved working directory most recently applied to the REPL process. */
let currentReplCwd: string | undefined = undefined;

function logDebug(message: string): void {
    if (debugMode) {
        outputChannel.appendLine(`[Pylot DEBUG] ${message}`);
    }
}

/** Log a message to the output channel if MCP debug mode is enabled. */
function logMcpDebug(message: string): void {
    if (mcpDebugMode) {
        outputChannel.appendLine(`[Pylot MCP DEBUG] ${message}`);
    }
}

function setLastExecutionResult(status: ExecutionStatus, success: boolean, executed: boolean): ExecutionResult {
    lastExecutionResult = { status, success, executed };
    return lastExecutionResult;
}

let runningAnimTimer: ReturnType<typeof setInterval> | null = null;
let pendingOutputShow = false;
let replStartPromise: Promise<boolean> | null = null;
let agentOutputBuffer: string = '';
let mcpHttpServer: http.Server | null = null;

// ── Timeout constants ───────────────────────────────────────────────────────

/** Maximum time (ms) to wait for the REPL to print its ready message. */
const REPL_STARTUP_TIMEOUT_MS = 5000;

/** Maximum time (ms) to wait for expression validation via the REPL. */
const VALIDATION_TIMEOUT_MS = 2000;

/** Maximum time (ms) to wait for an async expression evaluation result. */
const ASYNC_EVAL_TIMEOUT_MS = 5000;

/** Interval (s) between Matplotlib GUI event pumps in the REPL loop. */
const MPL_EVENT_PUMP_INTERVAL_S = 0.05;

// ── Activation ──────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    // Set context keys immediately so keybinding when-clauses resolve before
    // any other extension's competing bindings can fire.
    vscode.commands.executeCommand('setContext', 'pylotActive', true);
    vscode.commands.executeCommand('setContext', 'pylotMarkerActive', true);

    // ── Inlay Hint Management ───────────────────────────────────────────

    function getHintsConfig() {
        return vscode.workspace.getConfiguration('pylot');
    }

    class HintStore {
        // Map<uri, Map<currentLine, { text, originalLine }>>
        // originalLine: the line number Python last reported for this hint.
        // When lines are inserted/deleted above a hint, currentLine shifts but
        // originalLine stays fixed so stale ghost hints can be detected and
        // evicted when fresh data arrives from the REPL at the original line.
        private hints = new Map<string, Map<number, { text: string; originalLine: number }>>();

        private forEachVisiblePythonEditor(callback: (editor: vscode.TextEditor) => void, uri?: string) {
            vscode.window.visibleTextEditors.forEach(editor => {
                if (editor.document.languageId !== 'python') {
                    return;
                }
                if (uri && editor.document.uri.toString() !== uri) {
                    return;
                }
                callback(editor);
            });
        }

        setHint(uri: string, line: number, text: string): boolean {
            let uriMap = this.hints.get(uri);
            if (!uriMap) {
                uriMap = new Map<number, { text: string; originalLine: number }>();
                this.hints.set(uri, uriMap);
            }
            // If this hint was previously shifted by document edits, its entry
            // lives at a *different* key (currentLine) but still has
            // originalLine === line.  Update the text at the shifted position so
            // the hint stays visually attached to the for-loop, even though the
            // Python bytecode still reports the old compile-time line number.
            for (const [existingLine, data] of uriMap.entries()) {
                if (data.originalLine === line && existingLine !== line) {
                    if (data.text === text) { return false; }
                    uriMap.set(existingLine, { text, originalLine: line });
                    return true;
                }
            }
            // No shifted entry found — store at the reported line as usual.
            const existing = uriMap.get(line);
            if (existing && existing.text === text) { return false; }
            uriMap.set(line, { text, originalLine: line });
            return true;
        }

        getHintsForLine(uri: string, line: number): string | undefined {
            return this.hints.get(uri)?.get(line)?.text;
        }

        clear() {
            this.hints.clear();
        }

        clearUri(uri: string) {
            this.hints.delete(uri);
            this.refreshEditorsForUri(uri);
        }

        deleteHint(uri: string, line: number) {
            const uriMap = this.hints.get(uri);
            if (!uriMap) return;
            // Direct key match
            if (uriMap.has(line)) {
                uriMap.delete(line);
                return;
            }
            // If the hint was shifted by document edits, its key changed but
            // originalLine still matches.
            for (const [existingLine, data] of uriMap.entries()) {
                if (data.originalLine === line) {
                    uriMap.delete(existingLine);
                    return;
                }
            }
        }

        refreshAllEditors() {
            this.forEachVisiblePythonEditor(editor => {
                this.applyToEditor(editor);
            });
        }

        refreshEditorsForUri(uri: string) {
            this.forEachVisiblePythonEditor(editor => {
                this.applyToEditor(editor);
            }, uri);
        }

        applyToEditor(editor: vscode.TextEditor) {
            const config = getHintsConfig();
            if (!config.get<boolean>('enableInlayHints', true)) {
                editor.setDecorations(hintDecorationType, []);
                return;
            }

            const uri = editor.document.uri.toString();
            const uriMap = this.hints.get(uri);
            if (!uriMap) {
                editor.setDecorations(hintDecorationType, []);
                return;
            }

            const decorations: vscode.DecorationOptions[] = [];
            for (const [line, data] of uriMap.entries()) {
                if (line >= editor.document.lineCount) continue;
                // Skip invisible placeholders (empty text from stale-clearing)
                if (data.text === '') continue;

                const range = new vscode.Range(line, 1000, line, 1000);
                decorations.push({
                    range,
                    renderOptions: {
                        after: {
                            contentText: ` → ${data.text}`
                        }
                    }
                });
            }
            editor.setDecorations(hintDecorationType, decorations);
        }

        adjustForDocumentChanges(uri: string, changes: readonly vscode.TextDocumentContentChangeEvent[]) {
            let uriMap = this.hints.get(uri);
            if (!uriMap) return;

            for (const change of changes) {
                const linesInserted = change.text.split('\n').length - 1;
                const linesDeleted = change.range.end.line - change.range.start.line;
                const lineDelta = linesInserted - linesDeleted;

                const startLine = change.range.start.line;
                const endLine = change.range.end.line;

                const newMap = new Map<number, { text: string; originalLine: number }>();
                for (const [line, data] of uriMap.entries()) {
                    // Clear hints for any line that was directly modified
                    if (line >= startLine && line <= endLine) {
                        continue;
                    }

                    if (line > endLine) {
                        // Shift the storage key but preserve originalLine so the
                        // ghost-eviction logic in setHint can still match it.
                        newMap.set(line + lineDelta, { text: data.text, originalLine: data.originalLine });
                    } else {
                        // Keep hints for lines preceding the edit
                        newMap.set(line, data);
                    }
                }
                uriMap = newMap;
                this.hints.set(uri, uriMap);
            }
            this.refreshEditorsForUri(uri);
        }
    }

    let hintDecorationType: vscode.TextEditorDecorationType;

    function updateDecorationType() {
        if (hintDecorationType) {
            hintDecorationType.dispose();
        }
        const config = getHintsConfig();
        const color = config.get<string>('inlayHintColor', '#ffdf0088');
        hintDecorationType = vscode.window.createTextEditorDecorationType({
            after: {
                margin: '0 0 0 1.5em',
                color: color,
                fontStyle: 'italic'
            }
        });
    }

    updateDecorationType();

    const hintStore = new HintStore();

    vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('pylot.enableInlayHints')) {
            hintStore.refreshAllEditors();
        } else if (e.affectsConfiguration('pylot.inlayHintColor')) {
            updateDecorationType();
            hintStore.refreshAllEditors();
        }
    }, null, context.subscriptions);

    vscode.workspace.onDidChangeTextDocument(e => {
        hintStore.adjustForDocumentChanges(e.document.uri.toString(), e.contentChanges);
    }, null, context.subscriptions);

    vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor && editor.document.languageId === 'python') {
            hintStore.applyToEditor(editor);
        }
    }, null, context.subscriptions);

    // (pylotActive and pylotMarkerActive are already set at the top of activate())

    outputChannel = vscode.window.createOutputChannel("pylot");

    // Initialize debug modes from settings
    const config = vscode.workspace.getConfiguration('pylot');
    debugMode = config.get<boolean>('debug.python', false) || config.get<boolean>('debugMode', false);
    mcpDebugMode = config.get<boolean>('debug.mcpServer', false) || config.get<boolean>('mcpServer.debugMode', false);

    // ── Line decorations (left-border style) ─────────────────────────────
    //
    // Uses coloured left borders instead of gutter icons so they don't
    // conflict with breakpoints.  The running state is animated via a
    // timer that cycles through pre-built opacity frames.

    // ── Gutter decoration SVGs ──────────────────────────────────────────

    const runningSvg = `data:image/svg+xml;utf8,
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 10" preserveAspectRatio="none">
        <g>
            <animate attributeName="opacity"
                     values="0.6;1;0.6"
                     dur="2s"
                     repeatCount="indefinite"
                     calcMode="spline"
                     keyTimes="0;0.5;1"
                     keySplines="0.42 0 0.58 1;0.42 0 0.58 1" />
            <!-- Background stripe -->
            <rect x="2" y="0" width="0.75" height="10" fill="rgb(255,140,0)" />
            <!-- Animated dashes -->
            <line x1="2.375" y1="0" x2="2.375" y2="20"
                    stroke="rgb(255,200,50)" stroke-width="0.75"
                    stroke-dasharray="5 5">
                <animate attributeName="stroke-dashoffset"
                        from="10" to="0"
                        dur="1s" repeatCount="indefinite"/>
            </line>
        </g>
        </svg>`;

    const executedSvg = `data:image/svg+xml;utf8,
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 10" preserveAspectRatio="none">
            <rect x="2" y="0" width="0.75" height="10" fill="rgb(0, 255, 0)" fill-opacity="0.8" />
        </svg>`;

    const errorSvg = `data:image/svg+xml;utf8,
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 10" preserveAspectRatio="none">
            <path d="M 2.5 0 Q 3 2.5 2.5 5 T 2.5 10" fill="none" stroke="rgb(255, 0, 0)" stroke-width="0.75" stroke-opacity="0.8" />
        </svg>`;

    const gutterRunningDecoration = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.parse(runningSvg),
        gutterIconSize: 'contain',
        isWholeLine: true,
        overviewRulerColor: 'rgba(255, 165, 0, 0.8)',
        overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    const gutterExecutedDecoration = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.parse(executedSvg),
        gutterIconSize: 'contain',
        isWholeLine: true,
        overviewRulerColor: 'rgba(0, 255, 0, 0.6)',
        overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    const gutterErrorDecoration = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.parse(errorSvg),
        gutterIconSize: 'contain',
        isWholeLine: true,
        overviewRulerColor: 'rgba(255, 0, 0, 0.6)',
        overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    /** Helper to get current marker style from settings */
    function getMarkerStyle() {
        return vscode.workspace.getConfiguration('pylot').get<string>('executionMarkerStyle', 'gutter');
    }

    const RUNNING_FRAMES = 20;
    const RUNNING_INTERVAL_MS = 100;
    const runningFrames: vscode.TextEditorDecorationType[] = [];

    for (let i = 0; i < RUNNING_FRAMES; i++) {
        const opacity = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin((i / RUNNING_FRAMES) * 2 * Math.PI));
        runningFrames.push(vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            borderWidth: '0 0 0 3px',
            borderStyle: 'solid',
            borderColor: `rgba(255, 165, 0, ${opacity.toFixed(2)})`,
            overviewRulerColor: 'rgba(255, 165, 0, 0.8)',
            overviewRulerLane: vscode.OverviewRulerLane.Left,
        }));
    }

    let runningAnimDocumentUri: string | null = null;
    let runningAnimRanges: vscode.Range[] = [];
    let runningAnimFrame = 0;

    function applyRunningAnimationToVisibleEditors(oldFrame: number, newFrame: number) {
        if (!runningAnimDocumentUri) return;
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.toString() === runningAnimDocumentUri) {
                const style = getMarkerStyle();
                if (style === 'border') {
                    if (oldFrame >= 0) editor.setDecorations(runningFrames[oldFrame], []);
                    editor.setDecorations(runningFrames[newFrame], runningAnimRanges);
                }
            }
        }
    }

    function startRunningAnimation(editor: vscode.TextEditor, ranges: vscode.Range[]) {
        stopRunningAnimation();

        // Clear any persistent executed/error markers for this document so we strictly show ONLY the running marker
        const uriString = editor.document.uri.toString();
        documentMarkers.delete(uriString);
        for (const ed of vscode.window.visibleTextEditors) {
            if (ed.document.uri.toString() === uriString) {
                applyMarkers(ed);
            }
        }

        runningAnimDocumentUri = uriString;
        runningAnimRanges = ranges;
        runningAnimFrame = 0;

        const style = getMarkerStyle();
        if (style === 'gutter') {
            for (const ed of vscode.window.visibleTextEditors) {
                if (ed.document.uri.toString() === runningAnimDocumentUri) {
                    ed.setDecorations(gutterRunningDecoration, ranges);
                }
            }
        } else if (style === 'border') {
            applyRunningAnimationToVisibleEditors(-1, 0);

            runningAnimTimer = setInterval(() => {
                if (!runningAnimDocumentUri) { return; }
                const previousFrame = runningAnimFrame;
                runningAnimFrame = (runningAnimFrame + 1) % RUNNING_FRAMES;
                applyRunningAnimationToVisibleEditors(previousFrame, runningAnimFrame);
            }, RUNNING_INTERVAL_MS);
        }
    }

    function stopRunningAnimation() {
        if (runningAnimTimer) {
            clearInterval(runningAnimTimer);
            runningAnimTimer = null;
        }
        if (runningAnimDocumentUri) {
            for (const ed of vscode.window.visibleTextEditors) {
                if (ed.document.uri.toString() === runningAnimDocumentUri) {
                    for (let i = 0; i < RUNNING_FRAMES; i++) {
                        ed.setDecorations(runningFrames[i], []);
                    }
                    ed.setDecorations(gutterRunningDecoration, []);
                }
            }
        }
        runningAnimDocumentUri = null;
        runningAnimRanges = [];
    }

    const executedDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        borderWidth: '0 0 0 3px',
        borderStyle: 'solid',
        borderColor: 'rgba(0, 255, 0, 0.75)',
        overviewRulerColor: 'rgba(0, 255, 0, 0.6)',
        overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    const errorDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        borderWidth: '0 0 0 3px',
        borderStyle: 'solid',
        borderColor: 'rgba(255, 0, 0, 0.75)',
        overviewRulerColor: 'rgba(255, 0, 0, 0.6)',
        overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    // ── Python interpreter discovery ────────────────────────────────────

    /** Resolve the active Python interpreter via the ms-python extension. */
    async function getPythonPath(): Promise<string | undefined> {
        const pythonExtension = vscode.extensions.getExtension<PythonExtensionApi>('ms-python.python');
        if (!pythonExtension) {
            vscode.window.showErrorMessage('Pylot: The Python extension (ms-python.python) is required for this feature. Please install it.');
            return undefined;
        }

        if (!pythonExtension.isActive) {
            await pythonExtension.activate();
        }

        const environment = pythonExtension.exports.environments.getActiveEnvironmentPath();
        if (!environment?.path) {
            vscode.window.showErrorMessage('Pylot: No Python interpreter selected. Please select an interpreter using the "Python: Select Interpreter" command.');
            return undefined;
        }

        return environment.path;
    }

    /**
     * Resolves the working directory for the REPL from the ordered fallback list
     * in `pylot.replWorkingDirectory`.
     *
     * Each entry is tried in order. The first entry whose variables can be fully
     * resolved AND whose resulting path exists on disk is returned.
     *
     * `${fileDirname}` is skipped for untitled / non-file documents.
     * `${workspaceFolder}` is skipped when no workspace is open.
     * `${userHome}` maps to the OS home directory.
     *
     * Returns `undefined` when no entry resolves (caller should preserve the
     * current REPL working directory by omitting the `cwd` field from commands).
     */
    function resolveWorkingDirectory(documentUri?: vscode.Uri): string | undefined {
        const config = vscode.workspace.getConfiguration('pylot');
        // Accept both the new array format and the old string format (backward compat).
        const rawSetting = config.get('replWorkingDirectory');
        const candidates: string[] = Array.isArray(rawSetting)
            ? rawSetting as string[]
            : (typeof rawSetting === 'string' && rawSetting.trim() !== '')
                ? [rawSetting as string]
                : ['${fileDirname}', '${workspaceFolder}', '${userHome}'];

        const isFile = documentUri?.scheme === 'file';

        // Resolve ${workspaceFolder} once
        let workspaceFolderPath: string | undefined;
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            if (documentUri) {
                const wf = vscode.workspace.getWorkspaceFolder(documentUri);
                workspaceFolderPath = wf
                    ? wf.uri.fsPath
                    : vscode.workspace.workspaceFolders[0].uri.fsPath;
            } else {
                workspaceFolderPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
            }
        }

        const filePath = isFile ? documentUri!.fsPath : undefined;
        const fileDirname = filePath ? path.dirname(filePath) : undefined;
        const userHome = os.homedir();

        for (const template of candidates) {
            // Check whether this template requires ${fileDirname} or ${file}
            // which are unavailable for untitled documents – skip if so.
            if (!isFile && /\$\{fileDirname\}|\$\{file\}/.test(template)) {
                logDebug(`[resolveWorkingDirectory] Skipping entry (no file path for untitled): ${template}`);
                continue;
            }
            // Skip entries that require ${workspaceFolder} when no workspace is open.
            if (!workspaceFolderPath && /\$\{workspaceFolder\}/.test(template)) {
                logDebug(`[resolveWorkingDirectory] Skipping entry (no workspace folder): ${template}`);
                continue;
            }

            let resolved = template;
            if (fileDirname) {
                resolved = resolved.replace(/\$\{fileDirname\}/g, fileDirname);
            }
            if (filePath) {
                resolved = resolved.replace(/\$\{file\}/g, filePath);
            }
            if (workspaceFolderPath) {
                resolved = resolved.replace(/\$\{workspaceFolder\}/g, workspaceFolderPath);
            }
            resolved = resolved.replace(/\$\{userHome\}/g, userHome);
            resolved = path.normalize(resolved);

            if (fs.existsSync(resolved)) {
                logDebug(`[resolveWorkingDirectory] Resolved to: ${resolved}`);
                return resolved;
            } else {
                logDebug(`[resolveWorkingDirectory] Path does not exist, skipping: ${resolved}`);
            }
        }

        logDebug('[resolveWorkingDirectory] No candidate resolved to an existing path, returning undefined.');
        return undefined;
    }

    // ── REPL management ─────────────────────────────────────────────────

    /**
     * Python bootstrap script injected into the REPL process.
     *
     * It reads JSON commands from stdin, executes them in a persistent
     * namespace, and communicates results back via stdout JSON messages.
     * A background thread reads stdin so the main loop can also pump
     * Matplotlib GUI events between commands.
     */
    const replWrapperCode = `
import sys, json, traceback, os, re, ast, time
import threading
import queue
import builtins

io_lock = threading.Lock()
real_stdout = sys.stdout

class LockedStdout:
    def write(self, s):
        with io_lock:
            real_stdout.write(s)
            real_stdout.flush()
    def flush(self):
        with io_lock:
            real_stdout.flush()

sys.stdout = LockedStdout()
sys.stderr = LockedStdout()

def send_msg(msg_type, **kwargs):
    kwargs['type'] = msg_type
    with io_lock:
        real_stdout.write(f"<<<PYLOT_JSON>>>{json.dumps(kwargs)}\\n")
        real_stdout.flush()

def get_locals_summary(changed_keys=None):
    try:
        import types
        summary = []
        for name, val in persistent_globals.items():
            if name.startswith('_'): continue
            if changed_keys is not None and name not in changed_keys: continue
            if isinstance(val, (types.ModuleType, types.FunctionType, types.MethodType, type)):
                continue
            s_val = repr(val) if isinstance(val, str) else str(val)
            s_val = s_val.replace('\\n', ' ')
            if len(s_val) > 100:
                s_val = s_val[:97] + "..."
            summary.append(f"{name}={s_val}")
        return ", ".join(summary)
    except Exception:
        return ""

send_msg('ready', version=sys.version.split()[0])

def print_exception_with_links(e):
    exc_type, exc_value, exc_tb = sys.exc_info()
    if exc_tb and exc_tb.tb_frame.f_code.co_filename == '<string>' and exc_tb.tb_next:
        exc_tb = exc_tb.tb_next

    lines = traceback.format_exception(exc_type, exc_value, exc_tb)
    sys.stderr.write("".join(lines))

def make_ast_constant(val):
    if hasattr(ast, 'Constant'):
        return ast.Constant(value=val)
    elif isinstance(val, int):
        return ast.Num(n=val)
    elif isinstance(val, str):
        return ast.Str(s=val)
    return None

class ProgressTransformer(ast.NodeTransformer):
    def __init__(self, filename):
        self.filename = filename

    def get_target_name(self, target):
        if isinstance(target, ast.Name):
            return target.id
        elif isinstance(target, (ast.Tuple, ast.List)):
            return ", ".join(self.get_target_name(elt) for elt in target.elts)
        return "var"

    def visit_For(self, node):
        self.generic_visit(node)
        func_name = ast.Name(id='_pylot_progress', ctx=ast.Load())
        line_num = make_ast_constant(node.lineno - 1)
        fname = make_ast_constant(self.filename)
        var_name = make_ast_constant(self.get_target_name(node.target))
        call = ast.Call(func=func_name, args=[node.iter, line_num, fname, var_name], keywords=[])
        ast.copy_location(call, node.iter)
        node.iter = call
        return node

def clear_function_for_loop_hints(tree, filename):
    for top_node in tree.body:
        if isinstance(top_node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for child in ast.walk(top_node):
                if isinstance(child, ast.For) and hasattr(child, 'lineno'):
                    send_msg('hints', line=child.lineno - 1, text='', filename=filename)

def get_changed_keys_and_lines(tree, fallback_line):
    changed_keys = set()
    key_to_line = {}

    def record_store_name(name, lineno):
        changed_keys.add(name)
        if lineno is not None and (name not in key_to_line or lineno > key_to_line[name]):
            key_to_line[name] = lineno

    class AssignmentTracker(ast.NodeVisitor):
        def visit_Name(self, node):
            if isinstance(node.ctx, ast.Store):
                record_store_name(node.id, getattr(node, 'lineno', None))

        def visit_FunctionDef(self, node):
            record_store_name(node.name, getattr(node, 'lineno', None))

        def visit_AsyncFunctionDef(self, node):
            record_store_name(node.name, getattr(node, 'lineno', None))

        def visit_ClassDef(self, node):
            record_store_name(node.name, getattr(node, 'lineno', None))

        def visit_Import(self, node):
            for alias in node.names:
                record_store_name(alias.asname or alias.name.split('.', 1)[0], getattr(node, 'lineno', None))

        def visit_ImportFrom(self, node):
            for alias in node.names:
                if alias.name == '*':
                    continue
                record_store_name(alias.asname or alias.name, getattr(node, 'lineno', None))

        def visit_ExceptHandler(self, node):
            if node.name:
                record_store_name(node.name, getattr(node, 'lineno', None))
            self.generic_visit(node)

        def visit_Global(self, node):
            for name in node.names:
                changed_keys.add(name)

        def visit_Nonlocal(self, node):
            for name in node.names:
                changed_keys.add(name)

    AssignmentTracker().visit(tree)

    line_keys = {}
    for key in changed_keys:
        line_no = key_to_line.get(key, fallback_line)
        line_keys.setdefault(line_no, set()).add(key)

    return changed_keys, line_keys

def _pylot_progress(iterable, line_number, filename, var_name="var"):
    try:
        total = len(iterable)
    except Exception:
        total = None

    start_time = time.time()
    last_update_time = start_time
    count = 0
    last_item = None

    try:
        for item in iterable:
            last_item = item
            count += 1
            current_time = time.time()
            if current_time - start_time >= 0.5 and current_time - last_update_time >= 0.5:
                last_update_time = current_time
                s_item = repr(item) if isinstance(item, str) else str(item)
                s_item = s_item.replace('\\n', ' ')
                if len(s_item) > 80: s_item = s_item[:77] + "..."
                var_str = f"{var_name}={s_item}"

                if total:
                    percent = count / total
                    bar_len = 25
                    filled = int(bar_len * percent)
                    bar = '■' * filled + '‐' * (bar_len - filled)
                    progress_str = f"[{bar}] {int(percent*100)}%, {var_str}"
                else:
                    progress_str = var_str
                send_msg('hints', line=line_number, text=progress_str, filename=filename)
            yield item
    finally:
        if count > 0:
            s_item = repr(last_item) if isinstance(last_item, str) else str(last_item)
            s_item = s_item.replace('\\n', ' ')
            if len(s_item) > 80: s_item = s_item[:77] + "..."
            final_str = f"{var_name}={s_item}"
            send_msg('hints', line=line_number, text=final_str, filename=filename)

persistent_globals = {'__name__': '__main__', '__doc__': None, '_pylot_progress': _pylot_progress}
input_queue = queue.Queue()
input_reply_queue = queue.Queue()

def custom_input(prompt=""):
    send_msg('input_request', prompt=str(prompt))
    reply = input_reply_queue.get()
    if reply is None:
        raise EOFError("EOF when reading a line")
    return reply

builtins.input = custom_input

mpl_mode = os.environ.get('PYLOT_MPL_MODE', 'auto')

def force_patch_matplotlib():
    try:
        import matplotlib.pyplot as plt
        if getattr(plt, '_pylot_patched', False):
            return
        plt.ion()

        original_show = plt.show
        def non_blocking_show(*args, **kwargs):
            kwargs['block'] = False
            original_show(*args, **kwargs)
        plt.show = non_blocking_show

        plt._pylot_patched = True
    except Exception:
        pass

def pump_events():
    if 'matplotlib.pyplot' not in sys.modules:
        return
    try:
        plt = sys.modules['matplotlib.pyplot']
        if not getattr(plt, '_pylot_patched', False):
            force_patch_matplotlib()

        if hasattr(plt, '_pylab_helpers'):
            for manager in plt._pylab_helpers.Gcf.get_all_fig_managers():
                if hasattr(manager.canvas, 'flush_events'):
                    manager.canvas.flush_events()
    except Exception:
        pass

if mpl_mode == 'always':
    force_patch_matplotlib()

def read_stdin():
    while True:
        try:
            line = sys.stdin.readline()
            if not line:
                input_queue.put(None)
                break

            try:
                command = json.loads(line.strip())
                if isinstance(command, dict):
                    action = command.get('action')
                    cmd_cwd = command.get('cwd')
                    if cmd_cwd:
                        try:
                            if os.getcwd() != cmd_cwd:
                                os.chdir(cmd_cwd)
                        except Exception:
                            pass

                    if action == 'input_reply':
                        input_reply_queue.put(command.get('value'))
                        continue
                    elif action == 'validate_async':
                        try:
                            adjusted_code = json.loads(command.get('code', '""'))
                            compile(adjusted_code, '<string>', 'eval')
                            send_msg('validate', valid=True)
                        except SyntaxError:
                            send_msg('validate', valid=False)
                        continue
                    elif action == 'evaluate_async':
                        try:
                            adjusted_code = json.loads(command.get('code', '""'))
                            result = eval(adjusted_code, persistent_globals)

                            datatype = type(result).__name__
                            shape = str(result.shape) if hasattr(result, 'shape') and isinstance(result.shape, tuple) else None
                            length = None
                            if hasattr(result, '__len__'):
                                try:
                                    length = str(len(result))
                                except Exception:
                                    pass

                            send_msg('evaluate_async', success=True, result=str(result), datatype=datatype, shape=shape, len=length)
                        except Exception:
                            send_msg('evaluate_async', success=False)
                        continue
                    elif action == 'interrupt':
                        try:
                            import _thread
                            _thread.interrupt_main()
                            send_msg('interrupt', success=True)
                        except Exception:
                            send_msg('interrupt', success=False)
                        continue
            except Exception:
                pass

            input_queue.put(line)
        except Exception:
            break

stdin_thread = threading.Thread(target=read_stdin, daemon=True)
stdin_thread.start()

while True:
    try:
        try:
            line = input_queue.get(timeout=${MPL_EVENT_PUMP_INTERVAL_S})
            if line is None:
                break
        except queue.Empty:
            if mpl_mode != 'never':
                pump_events()
            continue

        command = json.loads(line.strip())
        action = command.get('action', 'execute')
        code = command['code']
        cmd_cwd = command.get('cwd')

        if cmd_cwd:
            try:
                if os.getcwd() != cmd_cwd:
                    os.chdir(cmd_cwd)
            except Exception:
                pass

        adjusted_code = json.loads(code)

        if action == 'validate':
            try:
                compile(adjusted_code, '<string>', 'eval')
                send_msg('validate', valid=True)
            except SyntaxError:
                send_msg('validate', valid=False)
            continue

        filename = command['filename']
        start_line = command.get('start_line', 1)
        use_progress = command.get('progress', True)

        if mpl_mode == 'auto' and 'matplotlib' in adjusted_code:
            force_patch_matplotlib()

        if start_line > 1:
            adjusted_code = ("\\n" * (start_line - 1)) + adjusted_code

        is_expression = False
        try:
            compiled = compile(adjusted_code, filename, 'eval')
            is_expression = True
        except SyntaxError:
            is_expression = False

        try:
            old_ids = {k: id(v) for k, v in persistent_globals.items()}
            fallback_line = adjusted_code.rstrip().count('\\n') + 1
            line_keys = {}
            if is_expression:
                result = eval(compiled, persistent_globals)
                if result is not None:
                    print(str(result))
                    datatype = type(result).__name__
                    shape = str(result.shape) if hasattr(result, 'shape') and isinstance(result.shape, tuple) else None
                    length = None
                    if hasattr(result, '__len__'):
                        try:
                            length = str(len(result))
                        except Exception:
                            pass
                    send_msg('execute', success=True, datatype=datatype, shape=shape, len=length)

                    res_str = repr(result) if isinstance(result, str) else str(result)
                    res_str = res_str.replace('\\n', ' ')
                    if len(res_str) > 100: res_str = res_str[:97] + "..."
                    expr_last_line_idx = adjusted_code.rstrip().count('\\n')
                    send_msg('hints', line=expr_last_line_idx, text=res_str, filename=filename)
                else:
                    send_msg('execute', success=True)
            else:
                try:
                    tree = ast.parse(adjusted_code)
                    clear_function_for_loop_hints(tree, filename)
                    _, line_keys = get_changed_keys_and_lines(tree, fallback_line)
                    if use_progress:
                        tree = ProgressTransformer(filename).visit(tree)
                    ast.fix_missing_locations(tree)
                    compiled = compile(tree, filename, 'exec')
                except Exception:
                    compiled = compile(adjusted_code, filename, 'exec')
                exec(compiled, persistent_globals)
                send_msg('execute', success=True)

            changed_keys = {k for k, v in persistent_globals.items() if k not in old_ids or old_ids[k] != id(v)}
            mapped_keys = set().union(*line_keys.values()) if line_keys else set()
            for k in changed_keys:
                if k not in mapped_keys:
                    line_keys.setdefault(fallback_line, set()).add(k)
                    mapped_keys.add(k)

            for l, keys in line_keys.items():
                summary = get_locals_summary(keys)
                if summary:
                    send_msg('hints', line=l-1, text=summary, filename=filename)
        except KeyboardInterrupt:
            print("\\nKeyboardInterrupt", file=sys.stderr)
            send_msg('execute', success=False)
        except Exception as e:
            print_exception_with_links(e)
            send_msg('execute', success=False)

    except KeyboardInterrupt:
        print("\\nKeyboardInterrupt", file=sys.stderr)
        send_msg('execute', success=False)
    except Exception as e:
        print_exception_with_links(e)
        send_msg('execute', success=False)
`;

    /**
     * Spawn a new persistent Python REPL process.
     * Resolves `true` once the REPL prints its ready message, or `false` on
     * timeout / error.
     */
    async function startPython(pythonPath: string, documentUri?: vscode.Uri): Promise<boolean> {
        if (replStartPromise) {
            logDebug('[startPython] REPL is already starting, awaiting existing promise...');
            return replStartPromise;
        }

        replStartPromise = new Promise((resolve) => {
            let resolved = false;
            let startupTimeout: ReturnType<typeof setTimeout> | null = null;
            let startupTimedOut = false;
            const resolveOnce = (value: boolean) => {
                if (resolved) return;
                resolved = true;
                if (startupTimeout) {
                    clearTimeout(startupTimeout);
                    startupTimeout = null;
                }
                replStartPromise = null;
                resolve(value);
            };

            let cwd = '';
            try {
                logDebug(`[startPython] Starting Python with path: ${pythonPath}`);
                logDebug(`[startPython] Document URI: ${documentUri?.toString()}`);

                const config = vscode.workspace.getConfiguration('pylot');
                const mplMode = config.get<string>('matplotlibEventHandler', 'auto');

                const pythonDir = path.dirname(pythonPath);
                const env: NodeJS.ProcessEnv = {
                    ...process.env,
                    PYTHONIOENCODING: 'utf-8',
                    PYLOT_MPL_MODE: mplMode
                };

                // Ensure the Python environment's bin directories are on PATH
                const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
                const separator = process.platform === 'win32' ? ';' : ':';

                let binPaths = '';
                if (process.platform === 'win32') {
                    binPaths = `${pythonDir}${separator}${path.join(pythonDir, 'Scripts')}${separator}${path.join(pythonDir, 'Library', 'bin')}${separator}`;
                } else {
                    binPaths = `${pythonDir}${separator}${path.join(pythonDir, 'bin')}${separator}`;
                }
                env[pathKey] = binPaths + (env[pathKey] || '');

                const resolvedCwd = resolveWorkingDirectory(documentUri);
                // For the initial REPL spawn we must have a concrete directory;
                // fall back to the process cwd if nothing resolves (e.g. untitled
                // file opened without a workspace).
                cwd = resolvedCwd ?? process.cwd();
                logDebug(`[startPython] Resolved working directory: ${cwd}`);

                // Track this as the current REPL working directory.
                currentReplCwd = cwd;

                // The new resolveWorkingDirectory already checks existsSync;
                // but if we fell back to process.cwd() we still validate.
                if (!fs.existsSync(cwd)) {
                    logDebug(`[startPython] Working directory does not exist, attempting to create: ${cwd}`);
                    try {
                        fs.mkdirSync(cwd, { recursive: true });
                        logDebug(`[startPython] Successfully created working directory: ${cwd}`);
                    } catch (mkdirError) {
                        logDebug(`[startPython] Failed to create working directory: ${cwd}`);
                        outputChannel.show(true);
                        outputChannel.appendLine(`[ERROR] Failed to create working directory "${cwd}" for REPL. Please check your 'pylot.replWorkingDirectory' setting.`);
                        resolveOnce(false);
                        return;
                    }
                } else {
                    logDebug(`[startPython] Working directory exists: ${cwd}`);
                }

                logDebug(`[startPython] Spawning REPL process with cwd: ${cwd}`);
                const startupProcess = spawn(pythonPath, ['-u', '-c', replWrapperCode], {
                    env: env,
                    cwd: cwd
                });
                pythonRepl = startupProcess;

                replReady = false;
                currentPythonPath = pythonPath;

                let stdoutBuffer = '';

                startupProcess.stdout?.on('data', (data) => {
                    if (pythonRepl !== startupProcess) return;

                    stdoutBuffer += data.toString();

                    let newlineIndex: number;
                    while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
                        const line = stdoutBuffer.slice(0, newlineIndex + 1);
                        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

                        const markerIndex = line.indexOf('<<<PYLOT_JSON>>>');
                        if (markerIndex !== -1) {
                            if (markerIndex > 0) {
                                const userOutput = line.substring(0, markerIndex);
                                if (!silentEvaluation) {
                                    if (pendingOutputShow) {
                                        outputChannel.show(true);
                                        pendingOutputShow = false;
                                    }
                                    outputChannel.append(userOutput);
                                }
                                agentOutputBuffer += userOutput;
                            }
                            const jsonStr = line.substring(markerIndex + '<<<PYLOT_JSON>>>'.length).trim();
                            try {
                                const msg = JSON.parse(jsonStr);

                                switch (msg.type) {
                                    case 'ready':
                                        if (startupTimedOut) {
                                            logDebug('[startPython] Ignoring late ready message after startup timeout.');
                                            break;
                                        }
                                        replReady = true;
                                        currentPythonVersion = msg.version || '';
                                        resolveOnce(true);
                                        break;

                                    case 'input_request':
                                        vscode.window.showInputBox({
                                            prompt: msg.prompt || '',
                                            ignoreFocusOut: true
                                        }).then(value => {
                                            const replyCommand = {
                                                action: 'input_reply',
                                                value: value !== undefined ? value : null
                                            };
                                            if (pythonRepl && pythonRepl.stdin) {
                                                pythonRepl.stdin.write(JSON.stringify(replyCommand) + '\n');
                                            }
                                        });
                                        break;

                                    case 'validate':
                                        if (validationCallback) {
                                            validationCallback(msg.valid);
                                            validationCallback = null;
                                        }
                                        break;

                                    case 'evaluate_async':
                                        if (asyncExpressionResultCallback) {
                                            asyncExpressionResultCallback(
                                                msg.success,
                                                msg.result || '',
                                                msg.datatype || '',
                                                msg.shape || '',
                                                msg.len || ''
                                            );
                                            asyncExpressionResultCallback = null;
                                        }
                                        break;

                                    case 'execute':
                                        if (msg.success) {
                                            lastExpressionType = msg.datatype || '';
                                            lastExpressionShape = msg.shape || '';
                                            lastExpressionLen = msg.len || '';
                                            if (currentExecutionCallback) {
                                                currentExecutionCallback(true);
                                                currentExecutionCallback = null;
                                            }
                                        } else {
                                            outputChannel.show(true);
                                            if (currentExecutionCallback) {
                                                currentExecutionCallback(false);
                                                currentExecutionCallback = null;
                                            }
                                        }
                                        break;
                                    case 'hints':
                                        const hintConfig = getHintsConfig();
                                        if (hintConfig.get<boolean>('enableInlayHints', true)) {
                                            const uri = (msg.filename && msg.filename !== '<string>')
                                                ? vscode.Uri.file(msg.filename).toString()
                                                : vscode.window.activeTextEditor?.document.uri.toString();
                                            if (uri) {
                                                const text = msg.text || '';
                                                // Always use setHint — even for empty text.
                                                // An empty-text entry acts as an invisible placeholder
                                                // that adjustForDocumentChanges still shifts, so when
                                                // the function is later called with stale bytecode the
                                                // hint lands at the correct (shifted) line.
                                                const maxLen = hintConfig.get<number>('maxInlayHintLength', 50);
                                                const trimmed = text.length > maxLen ? text.substring(0, maxLen - 3) + '...' : text;
                                                if (hintStore.setHint(uri, msg.line, trimmed)) {
                                                    hintStore.refreshEditorsForUri(uri);
                                                }
                                            }
                                        }
                                        break;
                                }
                            } catch (e) {
                                // Fallback for invalid JSON
                            }
                        } else {
                            if (!silentEvaluation) {
                                if (pendingOutputShow) {
                                    outputChannel.show(true);
                                    pendingOutputShow = false;
                                }
                                outputChannel.append(line);
                            }
                            agentOutputBuffer += line;
                        }
                    }
                });

                startupProcess.stderr?.on('data', (data) => {
                    if (pythonRepl !== startupProcess) return;

                    const stderrText = data.toString();
                    if (stderrText) {
                        outputChannel.show(true);
                        outputChannel.appendLine(`[Python stderr] ${stderrText}`);
                        agentOutputBuffer += `[Python stderr] ${stderrText}\n`;
                    }
                });

                startupProcess.on('close', (code) => {
                    if (pythonRepl !== startupProcess) {
                        logDebug(`[startPython] Old REPL process closed with code: ${code}`);
                        return;
                    }

                    logDebug(`[startPython] REPL process closed with code: ${code}`);
                    pythonRepl = null;
                    replReady = false;
                    if (code === null) {
                        // null exit code typically means the process crashed during startup
                        logDebug(`[startPython] REPL process exited with code null - startup crash`);
                        outputChannel.appendLine(`[ERROR] REPL process crashed during startup. This may indicate the Python executable is not working correctly or there was a startup error.`);
                        outputChannel.appendLine(`[ERROR] Working directory: ${cwd}`);
                        outputChannel.appendLine(`[ERROR] Python path: ${pythonPath}`);
                        resolveOnce(false);
                    } else if (code !== 0) {
                        // Non-zero exit code indicates an error
                        logDebug(`[startPython] REPL process exited with non-zero code ${code}`);
                        outputChannel.appendLine(`[ERROR] REPL process exited with non-zero code ${code}. This may indicate the Python executable is not working correctly or there was a startup error.`);
                        resolveOnce(false);
                    } else {
                        outputChannel.appendLine(`[REPL process closed normally]`);
                    }
                });

                startupProcess.on('error', (err: any) => {
                    if (pythonRepl !== startupProcess) {
                        logDebug(`[startPython] Old REPL process error: ${err.code || 'unknown'}`);
                        return;
                    }

                    logDebug(`[startPython] REPL process error: ${err.code || 'unknown'}, message: ${err.message}`);
                    outputChannel.show(true);
                    const cwdMessage = `(Current working directory: ${cwd})`;
                    // Check if the error is about a missing file (ENOENT)
                    if (err.code === 'ENOENT') {
                        // ENOENT can mean either the Python executable doesn't exist OR the working directory doesn't exist
                        logDebug('[startPython] ENOENT error - file not found');
                        outputChannel.appendLine(`[ERROR] Failed to start REPL.`);
                        if (pythonPath && !fs.existsSync(pythonPath)) {
                            logDebug(`[startPython] Python executable not found at: ${pythonPath}`);
                            outputChannel.appendLine(`The Python executable was not found at "${pythonPath}".`);
                            outputChannel.appendLine(`Please check your Python interpreter path in the settings (pylot.pythonExecutable).`);
                        } else if (!fs.existsSync(cwd)) {
                            logDebug(`[startPython] Working directory does not exist: ${cwd}`);
                            outputChannel.appendLine(`The working directory could not be accessed: ${cwd}`);
                            outputChannel.appendLine(`The file may be unsaved without a workspace folder. Please save the file or ensure a valid workspace is open.`);
                        } else {
                            logDebug(`[startPython] ENOENT but both Python and cwd exist - unknown cause`);
                            outputChannel.appendLine(`Either the Python executable was not found at "${pythonPath}" or the working directory could not be accessed.`);
                            outputChannel.appendLine(`Please check your Python interpreter path and ensure the working directory exists.`);
                        }
                        outputChannel.appendLine(cwdMessage);
                    } else {
                        logDebug(`[startPython] Non-ENOENT error: ${err.code || 'unknown'}`);
                        outputChannel.appendLine(`[ERROR] Failed to start REPL. This might be due to an incorrect Python path or an invalid working directory.`);
                        outputChannel.appendLine(`Please check your Python interpreter settings and 'pylot.replWorkingDirectory'.`);
                        outputChannel.appendLine(`${err.message} ${cwdMessage}`);
                    }
                    pythonRepl = null;
                    replReady = false;
                    resolveOnce(false);
                });

                // Timeout if REPL doesn't become ready
                startupTimeout = setTimeout(() => {
                    startupTimedOut = true;
                    if (pythonRepl === startupProcess) {
                        // Disassociate this startup process first so late stdout messages are ignored.
                        pythonRepl = null;
                        replReady = false;
                    }
                    logDebug(`[startPython] REPL startup timed out after ${REPL_STARTUP_TIMEOUT_MS}ms; terminating process.`);
                    startupProcess.kill();
                    resolveOnce(false);
                }, REPL_STARTUP_TIMEOUT_MS);

            } catch (err: any) {
                logDebug(`[startPython] Exception in startPython: ${err.message}`);
                outputChannel.show(true);
                const cwdMessage = `(Current working directory: ${cwd})`;
                if (pythonPath && !fs.existsSync(pythonPath)) {
                    logDebug(`[startPython] Python executable not found at: ${pythonPath}`);
                    outputChannel.appendLine(`[ERROR] Exception when attempting to start REPL.`);
                    outputChannel.appendLine(`The Python executable was not found at "${pythonPath}".`);
                    outputChannel.appendLine(`Please check your Python interpreter path in the settings (pylot.pythonExecutable).`);
                } else {
                    logDebug(`[startPython] Exception but Python executable exists - cwd issue?`);
                    outputChannel.appendLine(`[ERROR] Exception when attempting to start REPL. This might be due to an incorrect Python path or an invalid working directory.`);
                    outputChannel.appendLine(`Please check your Python interpreter settings and 'pylot.replWorkingDirectory'.`);
                }
                outputChannel.appendLine(err.message + ' ' + cwdMessage);
                resolveOnce(false);
            }
        });
        return replStartPromise;
    }

    /** Kill the REPL process if it is running. */
    function stopRepl() {
        hintStore.clear();
        hintStore.refreshAllEditors();
        if (currentExecutionCallback) {
            currentExecutionCallback(false);
            currentExecutionCallback = null;
        }

        if (pythonRepl) {
            pythonRepl.kill();
            pythonRepl = null;
            replReady = false;
        }
        replStartPromise = null;
    }

    // ── Line decoration helpers ─────────────────────────────────────────

    interface EditorMarkers {
        executed: vscode.Range[];
        error: vscode.Range[];
    }
    const documentMarkers = new Map<string, EditorMarkers>();

    function applyMarkers(editor: vscode.TextEditor) {
        if (editor.document.languageId !== 'python') return;
        const key = editor.document.uri.toString();
        const markers = documentMarkers.get(key) || { executed: [], error: [] };
        const style = getMarkerStyle();

        if (style === 'border') {
            editor.setDecorations(executedDecoration, markers.executed);
            editor.setDecorations(errorDecoration, markers.error);
            editor.setDecorations(gutterExecutedDecoration, []);
            editor.setDecorations(gutterErrorDecoration, []);
        } else if (style === 'gutter') {
            editor.setDecorations(gutterExecutedDecoration, markers.executed);
            editor.setDecorations(gutterErrorDecoration, markers.error);
            editor.setDecorations(executedDecoration, []);
            editor.setDecorations(errorDecoration, []);
        } else {
            editor.setDecorations(executedDecoration, []);
            editor.setDecorations(errorDecoration, []);
            editor.setDecorations(gutterExecutedDecoration, []);
            editor.setDecorations(gutterErrorDecoration, []);
        }
    }

    function addMarker(editor: vscode.TextEditor, range: vscode.Range, isError: boolean) {
        const key = editor.document.uri.toString();

        // Ensure only ONE marker is visible per file
        const markers: EditorMarkers = { executed: [], error: [] };

        if (isError) {
            markers.error.push(range);
        } else {
            markers.executed.push(range);
        }
        documentMarkers.set(key, markers);

        // Apply to all visible editors rendering this document
        for (const visibleEditor of vscode.window.visibleTextEditors) {
            if (visibleEditor.document.uri.toString() === key) {
                applyMarkers(visibleEditor);
            }
        }
    }

    vscode.window.onDidChangeVisibleTextEditors(editors => {
        for (const editor of editors) {
            if (editor.document.languageId === 'python') {
                hintStore.applyToEditor(editor);
            }
            applyMarkers(editor);

            if (runningAnimDocumentUri && editor.document.uri.toString() === runningAnimDocumentUri) {
                const style = getMarkerStyle();
                if (style === 'gutter') {
                    editor.setDecorations(gutterRunningDecoration, runningAnimRanges);
                } else if (style === 'border') {
                    editor.setDecorations(runningFrames[runningAnimFrame], runningAnimRanges);
                }
            }
        }
    }, null, context.subscriptions);

    /** Clear all Pylot line decorations from every visible Python editor. */
    function removeAllColorMarks() {
        stopRunningAnimation();
        documentMarkers.clear();
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.languageId === 'python') {
                for (let i = 0; i < RUNNING_FRAMES; i++) {
                    editor.setDecorations(runningFrames[i], []);
                }
                editor.setDecorations(executedDecoration, []);
                editor.setDecorations(errorDecoration, []);
                editor.setDecorations(gutterRunningDecoration, []);
                editor.setDecorations(gutterExecutedDecoration, []);
                editor.setDecorations(gutterErrorDecoration, []);
            }
        }
    }

    /** Clear Pylot line decorations only for the active editor(s) showing its document. */
    function removeActiveEditorColorMarks() {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) return;

        stopRunningAnimation();
        const key = activeEditor.document.uri.toString();
        documentMarkers.delete(key);

        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.toString() === key) {
                for (let i = 0; i < RUNNING_FRAMES; i++) {
                    editor.setDecorations(runningFrames[i], []);
                }
                editor.setDecorations(executedDecoration, []);
                editor.setDecorations(errorDecoration, []);
                editor.setDecorations(gutterRunningDecoration, []);
                editor.setDecorations(gutterExecutedDecoration, []);
                editor.setDecorations(gutterErrorDecoration, []);
            }
        }
    }

    // ── Code execution ──────────────────────────────────────────────────

    /**
     * Send a code block to the REPL and track its execution via line
     * decorations. Resolves with `{ success, executed }`.
     */
    function executeInRepl(command: any, editor: vscode.TextEditor, trimmedRange: vscode.Range, canExecute: boolean): Promise<ExecutionResult> {
        return new Promise((resolve) => {
            if (!canExecute) {
                resolve(setLastExecutionResult('rejected', false, false));
                return;
            }

            pendingOutputShow = true;
            setLastExecutionResult('running', false, false);

            const style = getMarkerStyle();

            if (style !== 'off') {
                startRunningAnimation(editor, [trimmedRange]);
            }

            currentExecutionCallback = (execSuccess: boolean) => {
                stopRunningAnimation();
                if (style !== 'off') {
                    addMarker(editor, trimmedRange, !execSuccess);
                }
                resolve(setLastExecutionResult(execSuccess ? 'succeeded' : 'failed', execSuccess, true));
            };

            agentOutputBuffer = ''; // Clear buffer before new execution
            pythonRepl?.stdin?.write(JSON.stringify(command) + '\n');
        });
    }

    // ── Smart-selection helpers ──────────────────────────────────────────

    /**
     * Return the first and last lines that contain non-blank text, ignoring
     * leading/trailing empty lines. Used to detect when a selection range
     * wraps the entire file (i.e. the root Module node).
     */
    function getCodeBounds(document: vscode.TextDocument): { firstCodeLine: number; lastCodeLine: number } {
        let firstCodeLine = 0;
        while (firstCodeLine < document.lineCount && document.lineAt(firstCodeLine).text.trim() === '') {
            firstCodeLine++;
        }
        let lastCodeLine = document.lineCount - 1;
        while (lastCodeLine >= 0 && document.lineAt(lastCodeLine).text.trim() === '') {
            lastCodeLine--;
        }
        return { firstCodeLine, lastCodeLine };
    }

    /**
     * Walk a SelectionRange chain upward until the parent would span the
     * entire file (the root Module node). Returns the range of the deepest
     * top-level block that still fits inside the file bounds.
     */
    /** Log the full SelectionRange chain for debugging. */
    function logSelectionHierarchy(label: string, selectionRange: any, firstCodeLine: number, lastCodeLine: number) {
        let debugNode = selectionRange;
        let step = 0;
        let debugStr = `[${label}] --- Hierarchy for selection ---\n`;
        while (debugNode) {
            const r = debugNode.range;
            debugStr += `  [Step ${step}] Lines ${r.start.line + 1}-${r.end.line + 1} ` +
                `(Chars ${r.start.character}-${r.end.character})\n`;
            debugNode = debugNode.parent;
            step++;
        }
        logDebug(debugStr + `  [File Bounds] Lines ${firstCodeLine + 1}-${lastCodeLine + 1}\n-----------------------------------------`);
    }

    function getTopBlock(selectionRange: any, document: vscode.TextDocument): vscode.Range {
        const { firstCodeLine, lastCodeLine } = getCodeBounds(document);

        logSelectionHierarchy('getTopBlock', selectionRange, firstCodeLine, lastCodeLine);

        let current = selectionRange;
        let blockRange = current.range;

        while (current.parent) {
            const parentRange = current.parent.range;
            // Stop before selecting the entire file (the Module root).
            if (firstCodeLine < lastCodeLine && parentRange.start.line <= firstCodeLine && parentRange.end.line >= lastCodeLine) {
                // But if blockRange is MORE indented than the first code line, it is nested
                // inside a block whose header is at the top of the file. Pylance sometimes
                // omits the intermediate Block node in this case (skipping directly to Module).
                // We must adopt the parent so the block body is included.
                // Top-level independent statements will always have the same indentation as
                // the first code line, so they break here correctly.
                const blockIndent = document.lineAt(blockRange.start.line).firstNonWhitespaceCharacterIndex;
                const firstLineIndent = document.lineAt(firstCodeLine).firstNonWhitespaceCharacterIndex;
                if (blockIndent <= firstLineIndent) {
                    break;
                }
                // Nested body line: adopt this parent range and keep going.
            }
            blockRange = parentRange;
            current = current.parent;
        }

        logDebug(`[getTopBlock] Selected Range: Lines ${blockRange.start.line + 1}-${blockRange.end.line + 1}`);
        return blockRange;
    }

    /**
     * Find the next executable line (non-blank, non-comment) starting from
     * `fromLine`. Returns -1 if none is found.
     */
    function findNextExecutableLine(document: vscode.TextDocument, fromLine: number): number {
        let line = fromLine;
        while (line < document.lineCount) {
            const text = document.lineAt(line).text.trim();
            if (text.length > 0 && !text.startsWith('#')) {
                return line;
            }
            line++;
        }
        return -1;
    }

    /**
     * Move the cursor to the given line's first non-whitespace character
     * and reveal it in the editor.
     */
    function moveCursorToLine(editor: vscode.TextEditor, lineNumber: number) {
        const line = editor.document.lineAt(lineNumber);
        const newPos = new vscode.Position(lineNumber, line.firstNonWhitespaceCharacterIndex);
        editor.selection = new vscode.Selection(newPos, newPos);
        editor.revealRange(new vscode.Range(newPos, newPos));
    }

    // ── Main execution logic ────────────────────────────────────────────

    /**
     * Core command handler. Determines the code block to execute (via
     * smart selection or explicit selection), sends it to the REPL, and
     * updates line decorations and cursor position.
     *
     * @param moveCursor If true, advance the cursor past the executed block.
     */
    async function executeSelectedPython(editor: vscode.TextEditor, moveCursor: boolean, wholeProgram: boolean = false): Promise<ExecutionResult> {
        const pythonPath = await getPythonPath();
        if (!pythonPath) { return setLastExecutionResult('rejected', false, false); }

        // For untitled files, we may not have document symbols yet.
        const isUntitled = editor.document.uri.scheme === 'untitled';

        // We no longer require the language server to be active to execute code.
        // If it isn't active, the SelectionRangeProvider will simply fall back
        // to evaluating the exact text highlighted by the user's cursor.

        // Start REPL if not running or if the interpreter changed
        if (!pythonRepl || !replReady || currentPythonPath !== pythonPath) {
            stopRepl();
            outputChannel.clear();
            outputChannel.show(true);

            const success = await startPython(pythonPath, editor.document.uri);
            if (!success) {
                // The detailed error message is already shown in the output channel
                vscode.window.showErrorMessage('Pylot: Failed to start Python REPL. Please check the "Pylot" output panel for details and review your Python interpreter settings and `pylot.replWorkingDirectory`.');
                return setLastExecutionResult('rejected', false, false);
            }
        }
        let initialStartLine = editor.selection.start.line;
        let initialEndLine = editor.selection.end.line;

        if (wholeProgram) {
            const bounds = getCodeBounds(editor.document);
            if (bounds.lastCodeLine < bounds.firstCodeLine) return setLastExecutionResult('rejected', false, false); // Empty file
            initialStartLine = bounds.firstCodeLine;
            initialEndLine = bounds.lastCodeLine;
        } else {
            // If the selection ends at column 0 of a line, exclude that line
            if (!editor.selection.isEmpty && editor.selection.end.character === 0 && initialEndLine > initialStartLine) {
                initialEndLine--;
            }
        }

        let isCellExecution = false;
        let cellTargetLine = -1;

        if (!wholeProgram && initialStartLine === initialEndLine) {
            const startLineText = editor.document.lineAt(initialStartLine).text.trimLeft();
            if (startLineText.startsWith('#%')) {
                isCellExecution = true;
                let nextCellLine = -1;
                let line = initialStartLine + 1;
                while (line < editor.document.lineCount) {
                    if (editor.document.lineAt(line).text.trimLeft().startsWith('#%')) {
                        nextCellLine = line;
                        break;
                    }
                    line++;
                }

                if (nextCellLine !== -1) {
                    initialEndLine = nextCellLine - 1;
                    cellTargetLine = nextCellLine;
                } else {
                    const bounds = getCodeBounds(editor.document);
                    initialEndLine = Math.max(initialStartLine, bounds.lastCodeLine);
                    const target = findNextExecutableLine(editor.document, initialEndLine + 1);
                    if (target >= 0) {
                        cellTargetLine = target;
                    } else if (initialEndLine + 1 < editor.document.lineCount) {
                        cellTargetLine = initialEndLine + 1;
                    }
                }
            }
        }

        // Trim leading non-executable lines (whitespace / comments)
        while (initialStartLine <= initialEndLine) {
            const text = editor.document.lineAt(initialStartLine).text.trim();
            if (text.length > 0 && !text.startsWith('#')) break;
            initialStartLine++;
        }

        // Trim trailing non-executable lines
        while (initialEndLine >= initialStartLine) {
            const text = editor.document.lineAt(initialEndLine).text.trim();
            if (text.length > 0 && !text.startsWith('#')) break;
            initialEndLine--;
        }

        let executionSelection: vscode.Selection | null = null;

        if (isCellExecution && initialStartLine <= initialEndLine) {
            executionSelection = new vscode.Selection(
                new vscode.Position(initialStartLine, editor.document.lineAt(initialStartLine).firstNonWhitespaceCharacterIndex),
                new vscode.Position(initialEndLine, editor.document.lineAt(initialEndLine).text.length)
            );
        }

        // ── Empty-line handling ─────────────────────────────────────────
        // When the trimmed range contains no executable code, either expand
        // to the enclosing block (if the cursor is inside one) or skip to
        // the next executable line.
        if (initialStartLine > initialEndLine) {
            let isInnerBlock = false;

            if (isCellExecution) {
                if (moveCursor && cellTargetLine >= 0) {
                    moveCursorToLine(editor, cellTargetLine);
                }
                return setLastExecutionResult('rejected', false, false);
            }

            if (editor.selection.isEmpty) {
                try {
                    const ranges: any = await vscode.commands.executeCommand('vscode.executeSelectionRangeProvider', editor.document.uri, [editor.selection.active]);

                    if (ranges && ranges.length > 0) {
                        const blockRange = getTopBlock(ranges[0], editor.document);

                        if (blockRange.start.line < blockRange.end.line) {
                            const { firstCodeLine, lastCodeLine } = getCodeBounds(editor.document);
                            // Reject if it spans the whole file (global scope)
                            if (blockRange.start.line <= firstCodeLine && blockRange.end.line >= lastCodeLine) {
                                isInnerBlock = false;
                            } else {
                                executionSelection = new vscode.Selection(blockRange.start, blockRange.end);
                                isInnerBlock = true;
                            }
                        }
                    }
                } catch (e) {
                    // Ignore — fallback to skipping
                }
            }

            // No enclosing block found → skip to the next executable line
            if (!isInnerBlock) {
                if (moveCursor) {
                    const nextLine = findNextExecutableLine(editor.document, editor.selection.end.line + 1);
                    if (nextLine >= 0) {
                        moveCursorToLine(editor, nextLine);
                    }
                }
                return setLastExecutionResult('rejected', false, false);
            }
        }

        // ── Standard smart-selection expansion ──────────────────────────
        // Use the language server's SelectionRangeProvider to expand the
        // selection to the nearest top-level statement/block.
        if (!executionSelection) {
            try {
                const queryStart = new vscode.Position(initialStartLine, editor.document.lineAt(initialStartLine).firstNonWhitespaceCharacterIndex);

                // Only query a second position when the selection actually spans multiple lines.
                // Sending two positions on the same line causes Pylance to return two identical
                // SelectionRange chains, which would make getTopBlock run (and log) twice.
                const queryPositions = initialStartLine === initialEndLine
                    ? [queryStart]
                    : [queryStart, new vscode.Position(initialEndLine, editor.document.lineAt(initialEndLine).firstNonWhitespaceCharacterIndex)];

                const ranges: any = await vscode.commands.executeCommand('vscode.executeSelectionRangeProvider', editor.document.uri, queryPositions);

                if (!ranges || ranges.length === 0) {
                    logDebug(`[executeSelectedPython] Selection range provider returned 0 ranges. Falling back to cursor bounds.`);
                    executionSelection = new vscode.Selection(queryStart, new vscode.Position(initialEndLine, editor.document.lineAt(initialEndLine).text.length));
                } else {
                    const startBlockRange = getTopBlock(ranges[0], editor.document);
                    const endBlockRange = ranges.length > 1 ? getTopBlock(ranges[1], editor.document) : startBlockRange;

                    executionSelection = new vscode.Selection(startBlockRange.start, endBlockRange.end);

                    // ── Pylance Edge Case: Top-level block headers ────────────────────
                    // If the selection is exactly one line long, and that line is the VERY FIRST
                    // executable line in the file, Pylance will often omit the actual Block
                    // node from the AST chain, jumping straight from the Header node to the
                    // Module root. This orphans the block body.
                    // We must peek ahead to the next line and check if it's structurally
                    // a child of our first line.
                    const { firstCodeLine, lastCodeLine } = getCodeBounds(editor.document);

                    // ── Guard: Shallow hierarchy (LS not yet ready) ─────────
                    // When Pylance is initialising, SelectionRange chains can be
                    // very shallow — jumping from a single-line statement directly
                    // to the Module root with no intermediate block nodes.
                    // getTopBlock then returns the full file, which would execute
                    // the entire script instead of just the cursor's block.
                    //
                    // For EACH query position independently: if getTopBlock
                    // returned a full-file range AND there are no intermediate
                    // multi-line nodes in that chain (other than the Module root
                    // itself), abort execution.
                    const isShallowFullFile = (blockRange: vscode.Range, chainRoot: any): boolean => {
                        if (!(blockRange.start.line <= firstCodeLine && blockRange.end.line >= lastCodeLine)) {
                            return false; // didn't expand to full file
                        }
                        let node = chainRoot;
                        while (node) {
                            const r = node.range;
                            const isMultiLine = r.start.line !== r.end.line;
                            const isModuleRoot = r.start.line <= firstCodeLine && r.end.line >= lastCodeLine;
                            if (isMultiLine && !isModuleRoot) {
                                return false; // legitimate intermediate block exists
                            }
                            node = node.parent;
                        }
                        return true; // no intermediate blocks — shallow hierarchy
                    };

                    const shallowStart = isShallowFullFile(startBlockRange, ranges[0]);
                    const shallowEnd = ranges.length > 1 && isShallowFullFile(endBlockRange, ranges[1]);
                    if (shallowStart || shallowEnd) {
                        logDebug(`[executeSelectedPython] Full-file expansion with shallow hierarchy (LS not ready?). Aborting. ` +
                            `start=${startBlockRange.start.line + 1}-${startBlockRange.end.line + 1}, ` +
                            `end=${endBlockRange.start.line + 1}-${endBlockRange.end.line + 1}, ` +
                            `shallowStart=${shallowStart}, shallowEnd=${shallowEnd}`);
                        return setLastExecutionResult('rejected', false, false);
                    }

                    // Only apply if the selection spans exactly the first code line, AND the active cursor is actually on that line.
                    if (executionSelection.start.line === firstCodeLine &&
                        executionSelection.end.line === firstCodeLine &&
                        editor.selection.active.line === firstCodeLine) {

                        const nextLine = findNextExecutableLine(editor.document, firstCodeLine + 1);
                        if (nextLine > firstCodeLine && nextLine <= lastCodeLine) {
                            // The next executable line is indented relative to firstCodeLine,
                            // which means firstCodeLine is a block header (e.g. `if True:`).
                            // We MUST find the enclosing block node via peek-ahead; if we
                            // cannot (e.g. because the language server is not yet ready and
                            // only returns a shallow Module-root), we do nothing rather than
                            // send an incomplete statement to the REPL.
                            const firstLineIndent = editor.document.lineAt(firstCodeLine).firstNonWhitespaceCharacterIndex;
                            const nextLineIndent = editor.document.lineAt(nextLine).firstNonWhitespaceCharacterIndex;
                            const nextLineIsChild = nextLineIndent > firstLineIndent;

                            let peekSucceeded = false;

                            const nextLinePos = new vscode.Position(nextLine, editor.document.lineAt(nextLine).firstNonWhitespaceCharacterIndex);
                            const nextRanges: any = await vscode.commands.executeCommand('vscode.executeSelectionRangeProvider', editor.document.uri, [nextLinePos]);

                            if (nextRanges && nextRanges.length > 0) {
                                logSelectionHierarchy('getTopBlock (peek-ahead)', nextRanges[0], firstCodeLine, lastCodeLine);
                                let peekNode = nextRanges[0];

                                // Walk up the next line's AST chain
                                while (peekNode) {
                                    const r = peekNode.range;

                                    // If we find a node that perfectly starts on our original line
                                    // AND spans down to cover our next line, then Pylance acknowledges
                                    // this is a single, contiguous multi-line block.
                                    //
                                    // Guard: reject any node whose end line exceeds lastCodeLine.
                                    // That is the hallmark of the shallow Module-root node that
                                    // Pylance returns when the language server is not yet fully
                                    // initialised. A real block node always ends at or before the
                                    // last code line. Adopting a Module-root here would execute the
                                    // entire file, which must never happen.
                                    if (r.start.line === firstCodeLine && r.end.line >= nextLine && r.end.line <= lastCodeLine) {
                                        logDebug(`[executeSelectedPython] Applied Peek-Ahead Fix: Adopting node spanning ${r.start.line + 1}-${r.end.line + 1}`);
                                        executionSelection = new vscode.Selection(r.start, r.end);
                                        peekSucceeded = true;
                                        break;
                                    }

                                    peekNode = peekNode.parent;
                                }
                            }

                            // If the cursor is on a block header (next line is indented) but
                            // the language server could not provide a proper block range, do
                            // nothing. Sending only the header line would produce a syntax
                            // error in the REPL.
                            if (!peekSucceeded && nextLineIsChild) {
                                logDebug(`[executeSelectedPython] Peek-Ahead found no valid block (LS not ready?). Aborting to avoid sending incomplete statement.`);
                                return setLastExecutionResult('rejected', false, false);
                            }
                        }
                    }
                }
            } catch (e) {
                logDebug(`[executeSelectedPython] Selection range provider failed. Falling back to cursor bounds.`);
                executionSelection = new vscode.Selection(
                    new vscode.Position(initialStartLine, editor.document.lineAt(initialStartLine).firstNonWhitespaceCharacterIndex),
                    new vscode.Position(initialEndLine, editor.document.lineAt(initialEndLine).text.length)
                );
            }
        }

        if (executionSelection.isEmpty) {
            executionSelection = new vscode.Selection(
                new vscode.Position(initialStartLine, editor.document.lineAt(initialStartLine).firstNonWhitespaceCharacterIndex),
                new vscode.Position(initialEndLine, editor.document.lineAt(initialEndLine).text.length)
            );
            if (executionSelection.isEmpty) {
                return setLastExecutionResult('rejected', false, false);
            }
        }

        // ── Build and send the command ──────────────────────────────────

        const code = editor.document.getText(executionSelection);
        // Resolve the working directory.
        // For named files, resolve using the fallback list.
        // For untitled files, pass undefined so no chdir happens in the REPL.
        const resolvedExecCwd = editor.document.uri.scheme === 'file'
            ? resolveWorkingDirectory(editor.document.uri)
            : undefined;
        if (resolvedExecCwd) {
            currentReplCwd = resolvedExecCwd;
        }

        const command = {
            code: JSON.stringify(code),
            filename: editor.document.fileName,
            start_line: executionSelection.start.line + 1,
            progress: vscode.workspace.getConfiguration('pylot').get<boolean>('enableForLoopLiveUpdates', true),
            ...(resolvedExecCwd ? { cwd: resolvedExecCwd } : {})
        };

        const trimmedRange = new vscode.Range(
            executionSelection.start,
            executionSelection.end
        );

        const originalSelection = editor.selection;
        const canExecute = pythonRepl !== null && replReady && currentExecutionCallback === null;

        // Advance the cursor before waiting for execution so the user can
        // continue editing immediately.
        if (canExecute && moveCursor) {
            let targetLine = -1;
            if (isCellExecution) {
                targetLine = cellTargetLine;
            } else {
                targetLine = findNextExecutableLine(editor.document, executionSelection.end.line + 1);
            }

            if (targetLine >= 0) {
                moveCursorToLine(editor, targetLine);
            } else {
                // No executable line found below the selection.
                // The user wants to move to one line after the block.
                const lineAfterBlock = executionSelection.end.line + 1;

                if (lineAfterBlock >= editor.document.lineCount) {
                    // We are at the very end of the document.
                    await editor.edit(editBuilder => {
                        const lastLine = editor.document.lineAt(editor.document.lineCount - 1);
                        editBuilder.insert(new vscode.Position(editor.document.lineCount - 1, lastLine.text.length), '\n');
                    });
                    moveCursorToLine(editor, lineAfterBlock);
                } else {
                    // There are lines after the block, but they aren't "executable" (likely comments or whitespace).
                    const nextLineText = editor.document.lineAt(lineAfterBlock).text;
                    if (nextLineText.trim().length === 0) {
                        // It's an empty line already. Just move there.
                        moveCursorToLine(editor, lineAfterBlock);
                    } else {
                        // It's not empty (e.g. a comment). Insert a newline so the block we just executed
                        // is separated from what follows.
                        await editor.edit(editBuilder => {
                            editBuilder.insert(new vscode.Position(lineAfterBlock, 0), '\n');
                        });
                        moveCursorToLine(editor, lineAfterBlock);
                    }
                }
            }
        }

        const result = await executeInRepl(command, editor, trimmedRange, canExecute);

        if (result.executed && !result.success) {
            // On error, collapse the selection so the error range stays visible
            const emptySelection = new vscode.Selection(originalSelection.active, originalSelection.active);
            editor.selection = emptySelection;
            editor.revealRange(emptySelection);
        }

        return result;
    }

    // ── Expression evaluation ───────────────────────────────────────────

    /**
     * Ask the persistent REPL whether `code` can be compiled as an
     * expression (eval) rather than a statement (exec). Uses the
     * `validate_async` action so no separate Python process is spawned.
     */
    function isValidPythonExpression(code: string): Promise<boolean> {
        return new Promise((resolve) => {
            if (!pythonRepl || !replReady) {
                resolve(false);
                return;
            }

            validationCallback = (isValid: boolean) => {
                resolve(isValid);
            };

            const command = {
                action: 'validate_async',
                code: JSON.stringify(code)
            };
            pythonRepl.stdin?.write(JSON.stringify(command) + '\n');

            // Timeout in case the REPL doesn't respond
            setTimeout(() => {
                if (validationCallback) {
                    validationCallback = null;
                    resolve(false);
                }
            }, VALIDATION_TIMEOUT_MS);
        });
    }

    // ── Execute Whole Program ───────────────────────────────────────────

    async function runWholeFile(editor: vscode.TextEditor): Promise<void> {
        await executeSelectedPython(editor, false, true);
    }

    // ── Command registrations ───────────────────────────────────────────

    const restartReplCommand = vscode.commands.registerCommand('pylot.startPython', async () => {
        removeAllColorMarks();
        stopRepl();
        const pythonPath = await getPythonPath();
        if (!pythonPath) { return; }

        outputChannel.clear();
        outputChannel.show(true);
        outputChannel.appendLine('[Pylot: Restarting Python ...]');

        const editor = vscode.window.activeTextEditor;
        const config = vscode.workspace.getConfiguration('pylot');
        debugMode = config.get<boolean>('debugMode', false);
        const success = await startPython(pythonPath, editor?.document.uri);
        if (success) {
            outputChannel.clear();
            if (debugMode) {
                outputChannel.appendLine(`[Pylot: Python ${currentPythonVersion} ready]`);
            }
            vscode.window.showInformationMessage('Pylot: Python restarted successfully.');
        } else {
            vscode.window.showErrorMessage('Pylot: Failed to restart the Python session. Please check the output channel for details or review your Python interpreter settings and the `pylot.replWorkingDirectory` setting.');
        }
    });

    const executeCommand = vscode.commands.registerCommand('pylot.executeSelectedPython', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return; }
        await executeSelectedPython(editor, true);
    });

    const executeNoMoveCommand = vscode.commands.registerCommand('pylot.executeSelectedPythonNoMove', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return; }
        await executeSelectedPython(editor, false);
    });

    const executeWholeCommand = vscode.commands.registerCommand('pylot.runWholeFile', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return; }
        await runWholeFile(editor);
    });

    const clearOutputCommand = vscode.commands.registerCommand('pylot.clearOutput', () => {
        outputChannel.clear();
    });
    const hideActiveLineMarkersCommand = vscode.commands.registerCommand('pylot.hideActiveLineMarkers', () => {
        removeActiveEditorColorMarks();
    });

    const evaluateExpressionCommand = vscode.commands.registerCommand('pylot.evaluateExpression', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return; }

        let selection = editor.selection;
        const hadSelection = !selection.isEmpty;
        let code: string;
        if (selection.isEmpty) {
            // No selection: evaluate the word at cursor
            const wordRange = editor.document.getWordRangeAtPosition(selection.active);
            if (!wordRange) { return; }
            code = editor.document.getText(wordRange).trim();
            selection = new vscode.Selection(wordRange.start, wordRange.end);
        } else {
            code = editor.document.getText(selection).trim();
        }
        if (!code) {
            vscode.window.showInformationMessage('No expression selected');
            return;
        }

        logDebug(`[evaluateExpression] Starting execution for file: ${editor.document.fileName}`);

        const pythonPath = await getPythonPath();
        if (!pythonPath) {
            logDebug('[evaluateExpression] No Python path found');
            return;
        }
        logDebug(`[evaluateExpression] Using Python path: ${pythonPath}`);

        // Start REPL if not running or if the interpreter changed
        if (!pythonRepl || !replReady || currentPythonPath !== pythonPath) {
            logDebug('[evaluateExpression] Restarting REPL due to configuration change');
            stopRepl();
            outputChannel.clear();
            outputChannel.show(true);

            const success = await startPython(pythonPath, editor.document.uri);
            if (!success) {
                logDebug('[evaluateExpression] Failed to start REPL');
                const errorMsg = editor.document.isUntitled
                    ? `Pylot: Cannot execute code in unsaved files. Please save the file first.`
                    : `Pylot: Failed to start Python interpreter. Please check your Python path settings.`;
                vscode.window.showErrorMessage(errorMsg);
                return;
            }
            logDebug('[evaluateExpression] REPL started successfully');
        } else {
            outputChannel.show(true);
        }

        // Validate via the REPL (requires REPL to be running)
        const isExpression = await isValidPythonExpression(code);
        if (!isExpression) {
            return;
        }

        lastExpressionResult = '';
        lastExpressionType = '';
        lastExpressionShape = '';
        lastExpressionLen = '';

        const resolvedEvalCwd = editor.document.uri.scheme === 'file'
            ? resolveWorkingDirectory(editor.document.uri)
            : undefined;
        if (resolvedEvalCwd) {
            currentReplCwd = resolvedEvalCwd;
        }

        const command = {
            action: 'evaluate_async',
            code: JSON.stringify(code),
            filename: editor.document.fileName,
            start_line: selection.start.line + 1,
            ...(resolvedEvalCwd ? { cwd: resolvedEvalCwd } : {})
        };

        const result = await new Promise<{ success: boolean; executed: boolean }>((resolve) => {
            if (!pythonRepl || !replReady) {
                resolve({ success: false, executed: false });
                return;
            }

            let resolved = false;
            const resolveOnce = (val: { success: boolean; executed: boolean }) => {
                if (resolved) { return; }
                resolved = true;
                asyncExpressionResultCallback = null;
                resolve(val);
            };

            asyncExpressionResultCallback = (success: boolean, resultText: string, type: string, shape: string, len: string) => {
                lastExpressionResult = resultText;
                lastExpressionType = type;
                lastExpressionShape = shape;
                lastExpressionLen = len;
                resolveOnce({ success: success, executed: true });
            };

            setTimeout(() => resolveOnce({ success: false, executed: false }), ASYNC_EVAL_TIMEOUT_MS);

            pythonRepl.stdin?.write(JSON.stringify(command) + '\n');
        });

        // ── Trigger Hover Tooltip ───────────────────────────────────────────

        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) return;

        if (result.success) {
            forceHoverResult = {
                expression: code,
                type: lastExpressionType,
                shape: lastExpressionShape,
                len: lastExpressionLen,
                result: lastExpressionResult,
                range: new vscode.Range(selection.start, selection.end)
            };
        } else {
            forceHoverResult = {
                expression: code,
                type: '',
                shape: '',
                len: '',
                result: '',
                range: new vscode.Range(selection.start, selection.end)
            };
        }

        // Restore the original selection so it doesn't collapse
        if (hadSelection) {
            activeEditor.selection = selection;
        }

        // Trigger the native hover command. The HoverProvider will intercept this
        // and use the `forceHoverResult` data.
        await vscode.commands.executeCommand('editor.action.showHover');
    });

    let forceHoverResult: { expression: string, type: string, shape: string, len: string, result: string, range: vscode.Range } | null = null;

    /** Build a Markdown tooltip from evaluation results. */
    function buildTooltipMarkdown(type: string, shape: string, len: string, result: string): vscode.MarkdownString {
        const markdown = new vscode.MarkdownString();
        if (!type && !result) {
            markdown.appendMarkdown(`*Expression cannot be evaluated*`);
            return markdown;
        }
        if (type) {
            let typeLine = `*\`type\`*: ${type}`;
            if (len) {
                typeLine += `, *\`len\`*: ${len}`;
            }
            if (shape) {
                // Format shape from "(10, 20)" to "10 x 20"
                const formattedShape = shape.replace(/[()]/g, '').replace(/,\s*$/, '').replace(/,\s*/g, ' \u00d7 ').trim();
                typeLine += `, *\`shape\`*: ${formattedShape}`;
            }
            markdown.appendMarkdown(typeLine);
        }
        if (result) {
            const lines = result.split(/\r?\n/);
            let displayResult = result;
            let truncated = false;
            if (lines.length > 50) {
                displayResult = lines.slice(0, 50).join('\n');
                truncated = true;
            }
            markdown.appendCodeblock(displayResult, 'text');
            if (truncated) {
                markdown.appendMarkdown('*... (truncated)*');
            }
        } else {
            markdown.appendMarkdown(`\n\n*Evaluated successfully (no output)*`);
        }
        return markdown;
    }

    const hoverProvider = vscode.languages.registerHoverProvider('python', {
        async provideHover(document, position, token) {
            // ── Handle forced hover from "Evaluate Expression" command ──
            if (forceHoverResult) {
                const markdown = buildTooltipMarkdown(forceHoverResult.type, forceHoverResult.shape, forceHoverResult.len, forceHoverResult.result);

                // Consume the forced result so it doesn't persistently hijack normal hovers
                forceHoverResult = null;
                return new vscode.Hover(markdown);
            }

            // ── Normal Hover Logic ──────────────────────────────────────────
            // Evaluate even if REPL is busy, since we use evaluate_async now
            if (!pythonRepl || !replReady) {
                return null;
            }

            const range = document.getWordRangeAtPosition(position);
            if (!range) { return null; }

            const word = document.getText(range);
            const lineText = document.lineAt(position.line).text;
            const textAfterWord = lineText.substring(range.end.character).trimLeft();

            // When there is a function call at the cursor, do not evaluate
            if (textAfterWord.startsWith('(')) {
                return null;
            }

            // Check if there is a selection covering the hover position
            let expressionToEvaluate = word;
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document === document && !editor.selection.isEmpty && editor.selection.contains(position)) {
                // If the selection exactly matches the word under cursor, treat as a single variable
                const selectionText = document.getText(editor.selection).trim();
                if (selectionText !== word) {
                    // Multi-token selection: do nothing automatically.
                    // We rely on the keyboard shortcut (Evaluate Expression) to trigger the hover.
                    return null;
                }
            }

            const isExpression = await isValidPythonExpression(expressionToEvaluate);
            if (!isExpression || token.isCancellationRequested) {
                return null;
            }

            // Double check state after await
            if (!pythonRepl || !replReady) {
                return null;
            }

            lastExpressionResult = '';
            lastExpressionType = '';
            lastExpressionShape = '';
            lastExpressionLen = '';

            const resolvedHoverCwd = document.uri.scheme === 'file'
                ? resolveWorkingDirectory(document.uri)
                : undefined;
            if (resolvedHoverCwd) {
                currentReplCwd = resolvedHoverCwd;
            }

            const command = {
                action: 'evaluate_async',
                code: JSON.stringify(expressionToEvaluate),
                filename: document.fileName,
                start_line: position.line + 1,
                ...(resolvedHoverCwd ? { cwd: resolvedHoverCwd } : {})
            };

            const evalResult = await new Promise<{ success: boolean; executed: boolean }>((resolve) => {
                let resolved = false;
                const resolveOnce = (val: { success: boolean; executed: boolean }) => {
                    if (resolved) { return; }
                    resolved = true;
                    asyncExpressionResultCallback = null;
                    resolve(val);
                };

                asyncExpressionResultCallback = (success: boolean, resultText: string, type: string, shape: string, len: string) => {
                    lastExpressionResult = resultText;
                    lastExpressionType = type;
                    lastExpressionShape = shape;
                    lastExpressionLen = len;
                    resolveOnce({ success: success, executed: true });
                };

                setTimeout(() => resolveOnce({ success: false, executed: false }), ASYNC_EVAL_TIMEOUT_MS);

                pythonRepl?.stdin?.write(JSON.stringify(command) + '\n');
            });

            if (token.isCancellationRequested) {
                return null;
            }

            if (!evalResult.success) {
                return null;
            }

            if (lastExpressionResult !== '' || lastExpressionType !== '') {
                return new vscode.Hover(buildTooltipMarkdown(lastExpressionType, lastExpressionShape, lastExpressionLen, lastExpressionResult));
            }

            return null;
        }
    });

    const interruptCommand = vscode.commands.registerCommand('pylot.interruptExecution', () => {
        if (!pythonRepl || !replReady) {
            vscode.window.showWarningMessage('Pylot REPL is not currently running.');
            return;
        }

        const command = { action: 'interrupt' };
        pythonRepl.stdin?.write(JSON.stringify(command) + '\n');
        vscode.window.showInformationMessage('Sent KeyboardInterrupt to Pylot REPL.');
    });

    const openFileCommand = vscode.commands.registerCommand('pylot.openFileAtLine', (filePath: string, line: number) => {
        vscode.workspace.openTextDocument(vscode.Uri.file(filePath)).then(doc => {
            vscode.window.showTextDocument(doc, {
                selection: new vscode.Range(line - 1, 0, line - 1, 0)
            });
        });
    });

    const linkProvider = vscode.languages.registerDocumentLinkProvider({ scheme: 'output' }, {
        provideDocumentLinks(document) {
            if (!document.uri.path.includes('pylot')) return [];

            const links: vscode.DocumentLink[] = [];
            const text = document.getText();
            const regex = /File "(.*?)", line (\d+)/g;
            let match;
            while ((match = regex.exec(text)) !== null) {
                const startPos = document.positionAt(match.index);
                const endPos = document.positionAt(match.index + match[0].length);
                const range = new vscode.Range(startPos, endPos);

                const filePath = match[1];
                const line = parseInt(match[2], 10);

                const argsStr = JSON.stringify([filePath, line]);
                const targetUri = vscode.Uri.parse(`command:pylot.openFileAtLine?${encodeURIComponent(argsStr)}`);

                const link = new vscode.DocumentLink(range, targetUri);
                link.tooltip = `Open ${filePath} at line ${line}`;
                links.push(link);
            }
            return links;
        }
    });

    // ── Inlay Hints Commands ────────────────────────────────────────────

    const clearInlayHintsCommand = vscode.commands.registerCommand('pylot.clearInlayHints', () => {
        hintStore.clear();
        hintStore.refreshAllEditors();
        vscode.window.showInformationMessage('Pylot: Inlay hints cleared.');
    });

    const toggleInlayHintsCommand = vscode.commands.registerCommand('pylot.toggleInlayHints', () => {
        const config = vscode.workspace.getConfiguration('pylot');
        const currentValue = config.get<boolean>('enableInlayHints', true);
        config.update('enableInlayHints', !currentValue, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Pylot: Inlay hints ${!currentValue ? 'enabled' : 'disabled'}.`);
    });

    // ── AI Agent API Commands ───────────────────────────────────────────

    const agentAppendAndExecuteCommand = vscode.commands.registerCommand('pylot.agent.appendAndExecute', async (args?: { code: string }) => {
        if (!args || typeof args.code !== 'string' || !args.code.trim()) {
            return { success: false, output: 'Error: code argument is required and must be a non-empty string.' };
        }

        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return { success: false, output: 'Error: No active text editor.' };
        }
        if (editor.document.languageId !== 'python') {
            return { success: false, output: 'Error: Active file is not a Python file.' };
        }

        // Append line to the bottom
        const lastLine = editor.document.lineCount - 1;
        const lastLineContent = editor.document.lineAt(lastLine).text;
        const needsNewline = lastLineContent.length > 0 && !lastLineContent.endsWith('\n');

        let codeToAppend = args.code;
        if (needsNewline) {
            codeToAppend = '\n' + codeToAppend;
        }
        // Ensure the appended code ends with a newline
        if (!codeToAppend.endsWith('\n')) {
            codeToAppend += '\n';
        }

        await editor.edit(editBuilder => {
            editBuilder.insert(new vscode.Position(lastLine, lastLineContent.length), codeToAppend);
        });

        // Determine the inserted lines
        const newTotalLines = editor.document.lineCount;
        const insertedLinesCount = codeToAppend.split('\n').length - 1;
        const startLine = Math.max(0, newTotalLines - insertedLinesCount - 1); // rough start line
        const endLine = newTotalLines - 1;

        // Create selection for the new code
        const startPos = new vscode.Position(startLine, editor.document.lineAt(startLine).firstNonWhitespaceCharacterIndex);
        const endPos = new vscode.Position(endLine, editor.document.lineAt(endLine).text.length);

        // Temporarily set selection
        const originalSelection = editor.selection;
        editor.selection = new vscode.Selection(startPos, endPos);
        editor.revealRange(editor.selection);

        // Execute
        let executionResult: ExecutionResult;
        try {
            executionResult = await executeSelectedPython(editor, false);
        } finally {
            // Restore selection
            editor.selection = originalSelection;
            editor.revealRange(editor.selection);
        }

        return { success: executionResult.success, executed: executionResult.executed, status: executionResult.status, output: agentOutputBuffer };
    });

    const agentExecuteRangeCommand = vscode.commands.registerCommand('pylot.agent.executeRange', async (args?: { startLine: number, endLine: number }) => {
        if (!args || typeof args.startLine !== 'number' || typeof args.endLine !== 'number') {
            return { success: false, output: 'Error: startLine and endLine arguments are required and must be numbers (0-indexed).' };
        }

        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return { success: false, output: 'Error: No active text editor.' };
        }
        if (editor.document.languageId !== 'python') {
            return { success: false, output: 'Error: Active file is not a Python file.' };
        }

        // Bound check
        const startLine = Math.max(0, args.startLine);
        const endLine = Math.min(editor.document.lineCount - 1, args.endLine);

        // Create selection
        const startPos = new vscode.Position(startLine, editor.document.lineAt(startLine).firstNonWhitespaceCharacterIndex);
        const endPos = new vscode.Position(endLine, editor.document.lineAt(endLine).text.length);

        const originalSelection = editor.selection;
        editor.selection = new vscode.Selection(startPos, endPos);
        editor.revealRange(editor.selection);

        let executionResult: ExecutionResult;
        try {
            executionResult = await executeSelectedPython(editor, false);
        } finally {
            editor.selection = originalSelection;
            editor.revealRange(editor.selection);
        }

        return { success: executionResult.success, executed: executionResult.executed, status: executionResult.status, output: agentOutputBuffer };
    });

    const agentGetExecutionStatusCommand = vscode.commands.registerCommand('pylot.agent.getExecutionStatus', () => {
        return { ready: replReady, running: currentExecutionCallback !== null, lastExecution: lastExecutionResult };
    });

    // Alias evaluateExpression, but parse args to support agent execution
    const agentEvaluateExpressionCommand = vscode.commands.registerCommand('pylot.agent.evaluateExpression', async (args?: { expression: string }) => {
        if (!args || typeof args.expression !== 'string' || !args.expression.trim()) {
            return { success: false, result: 'Error: expression argument is required.' };
        }

        if (!pythonRepl || !replReady) {
            return { success: false, result: 'Error: Python REPL is not active.' };
        }

        const isExpression = await isValidPythonExpression(args.expression);
        if (!isExpression) {
            return { success: false, result: 'Error: Invalid Python expression.' };
        }

        const editor = vscode.window.activeTextEditor;
        const resolvedEvalCwd = editor?.document.uri.scheme === 'file'
            ? resolveWorkingDirectory(editor.document.uri)
            : undefined;

        const command = {
            action: 'evaluate_async',
            code: JSON.stringify(args.expression),
            filename: editor?.document.fileName || '<agent>',
            start_line: 1,
            ...(resolvedEvalCwd ? { cwd: resolvedEvalCwd } : {})
        };

        const result = await new Promise<{ success: boolean; executed: boolean }>((resolve) => {
            let resolved = false;
            const resolveOnce = (val: { success: boolean; executed: boolean }) => {
                if (resolved) { return; }
                resolved = true;
                asyncExpressionResultCallback = null;
                resolve(val);
            };

            asyncExpressionResultCallback = (success: boolean, resultText: string, type: string, shape: string, len: string) => {
                lastExpressionResult = resultText;
                lastExpressionType = type;
                lastExpressionShape = shape;
                lastExpressionLen = len;
                resolveOnce({ success: success, executed: true });
            };

            setTimeout(() => resolveOnce({ success: false, executed: false }), ASYNC_EVAL_TIMEOUT_MS);

            pythonRepl?.stdin?.write(JSON.stringify(command) + '\n');
        });

        return {
            success: result.success,
            result: lastExpressionResult,
            type: lastExpressionType,
            shape: lastExpressionShape,
            len: lastExpressionLen
        };
    });

    const agentGetOutputCommand = vscode.commands.registerCommand('pylot.agent.getOutput', () => {
        return agentOutputBuffer;
    });

    const agentReadFileCommand = vscode.commands.registerCommand('pylot.agent.readFile', async (args?: { include_line_numbers: boolean }) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return 'Error: No active text editor.';
        }

        const document = editor.document;
        const includeLineNumbers = args?.include_line_numbers ?? false;

        if (!includeLineNumbers) {
            return document.getText();
        }

        let result = '';
        for (let i = 0; i < document.lineCount; i++) {
            result += `${i}: ${document.lineAt(i).text}\n`;
        }
        return result;
    });

    const agentEditCodeCommand = vscode.commands.registerCommand('pylot.agent.editCode', async (args?: { search_string: string, replace_string: string }) => {
        if (!args || typeof args.search_string !== 'string' || typeof args.replace_string !== 'string') {
            return { success: false, output: 'Error: search_string and replace_string are required.' };
        }

        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return { success: false, output: 'Error: No active text editor.' };
        }

        const document = editor.document;
        const fullText = document.getText();
        const searchString = args.search_string;
        const replaceString = args.replace_string;

        if (!fullText.includes(searchString)) {
            return { success: false, output: 'Error: search_string not found in file. Please read the file again to check the exact indentation and content.' };
        }

        // We use editor.edit to handle the replacement within VS Code's undo/redo stack
        const success = await editor.edit(editBuilder => {
            let index = fullText.indexOf(searchString);
            while (index !== -1) {
                const startPos = document.positionAt(index);
                const endPos = document.positionAt(index + searchString.length);
                editBuilder.replace(new vscode.Range(startPos, endPos), replaceString);
                // If we only want to replace the FIRST occurrence, we could break here.
                // But usually LLMs provide a unique enough search string.
                // The prompt says "exact search and replace", usually implying one or all.
                // Let's replace all occurrences to be safe if they are identical.
                index = fullText.indexOf(searchString, index + searchString.length);
            }
        });

        return { success, output: success ? 'Code updated successfully.' : 'Error: Failed to apply edits.' };
    });

    const agentRestartReplCommand = vscode.commands.registerCommand('pylot.agent.restartRepl', async () => {
        await vscode.commands.executeCommand('pylot.startPython');
        return { success: true, output: 'REPL restarted.' };
    });

    const agentInterruptExecutionCommand = vscode.commands.registerCommand('pylot.agent.interruptExecution', async () => {
        await vscode.commands.executeCommand('pylot.interruptExecution');
        return { success: true, output: 'Sent KeyboardInterrupt to REPL.' };
    });

    context.subscriptions.push(hoverProvider);
    context.subscriptions.push(executeCommand);
    context.subscriptions.push(executeNoMoveCommand);
    context.subscriptions.push(executeWholeCommand);
    context.subscriptions.push(restartReplCommand);
    context.subscriptions.push(clearOutputCommand);
    context.subscriptions.push(hideActiveLineMarkersCommand);
    context.subscriptions.push(evaluateExpressionCommand);
    context.subscriptions.push(interruptCommand);
    context.subscriptions.push(openFileCommand);
    context.subscriptions.push(linkProvider);
    context.subscriptions.push(clearInlayHintsCommand);
    context.subscriptions.push(toggleInlayHintsCommand);

    // Agent Subscriptions
    context.subscriptions.push(agentAppendAndExecuteCommand);
    context.subscriptions.push(agentExecuteRangeCommand);
    context.subscriptions.push(agentGetExecutionStatusCommand);
    context.subscriptions.push(agentEvaluateExpressionCommand);
    context.subscriptions.push(agentGetOutputCommand);
    context.subscriptions.push(agentReadFileCommand);
    context.subscriptions.push(agentEditCodeCommand);
    context.subscriptions.push(agentRestartReplCommand);
    context.subscriptions.push(agentInterruptExecutionCommand);

    // ── MCP HTTP IPC server (SSE Transport) ───────────────────────────────────

    /** Allowed command prefixes that the MCP server may execute. */
    const ALLOWED_MCP_COMMANDS = [
        'pylot.agent.appendAndExecute',
        'pylot.agent.executeRange',
        'pylot.agent.getExecutionStatus',
        'pylot.agent.evaluateExpression',
        'pylot.agent.getOutput',
        'pylot.agent.readFile',
        'pylot.agent.editCode',
        'pylot.agent.restartRepl',
        'pylot.agent.interruptExecution',
    ];

    const MCP_TOOLS = [
        {
            name: 'pylot_append_and_execute',
            description: 'Appends Python code to the bottom of the active Python editor and executes it in the persistent Pylot REPL. The REPL is stateful: variables defined in previous calls remain available. Returns the captured stdout/stderr output and a success flag.',
            inputSchema: {
                type: 'object',
                properties: {
                    code: { type: 'string', description: 'Python source code to append and execute. May be multi-line.' }
                },
                required: ['code']
            }
        },
        {
            name: 'pylot_execute_range',
            description: 'Executes a range of lines already present in the active Python editor (0-indexed). Useful for re-running an existing section of code without appending new lines.',
            inputSchema: {
                type: 'object',
                properties: {
                    startLine: { type: 'integer', description: 'First line to execute (0-indexed, inclusive).' },
                    endLine: { type: 'integer', description: 'Last line to execute (0-indexed, inclusive).' }
                },
                required: ['startLine', 'endLine']
            }
        },
        {
            name: 'pylot_get_status',
            description: 'Returns the current execution status of the Pylot REPL. Use this to check whether the REPL is ready before sending code, or to poll until a long-running execution completes.',
            inputSchema: { type: 'object', properties: {} }
        },
        {
            name: 'pylot_evaluate_expression',
            description: 'Evaluates a single Python expression in the REPL without appending it to the editor. Returns the string representation, type, shape (for NumPy arrays), and length (for sized objects). Ideal for inspecting variable values without modifying the document.',
            inputSchema: {
                type: 'object',
                properties: {
                    expression: { type: 'string', description: 'A valid Python expression (not a statement) to evaluate, e.g. "my_df.shape".' }
                },
                required: ['expression']
            }
        },
        {
            name: 'pylot_get_output',
            description: 'Returns the accumulated stdout/stderr text from the most recent code execution. Call this after pylot_append_and_execute or pylot_execute_range to retrieve all printed output.',
            inputSchema: { type: 'object', properties: {} }
        },
        {
            name: 'pylot_read_file',
            description: 'Reads the current contents of the active Python editor. Use this to inspect the current code before modifying it or to find exact line numbers for execution.',
            inputSchema: {
                type: 'object',
                properties: {
                    include_line_numbers: { type: 'boolean', description: "If true, prepends 0-indexed line numbers to each line (e.g., '0: import sys', '1: print(sys.path)')." }
                }
            }
        },
        {
            name: 'pylot_edit_code',
            description: 'Modifies the active Python file using an exact search and replace. Use this to fix errors, refactor code, or update variables without rewriting the entire file.',
            inputSchema: {
                type: 'object',
                properties: {
                    search_string: { type: 'string', description: 'The exact string currently in the file that you want to replace.' },
                    replace_string: { type: 'string', description: 'The new string to insert in place of the search_string.' }
                },
                required: ['search_string', 'replace_string']
            }
        },
        {
            name: 'pylot_restart_repl',
            description: 'Restarts the persistent Python REPL, clearing all memory, user-defined variables, and imported modules.',
            inputSchema: { type: 'object', properties: {} }
        },
        {
            name: 'pylot_interrupt_execution',
            description: 'Sends a KeyboardInterrupt (Ctrl+C) to the running Python process. Use this to stop infinite loops or long-running computations.',
            inputSchema: { type: 'object', properties: {} }
        }
    ];

    const MCP_TOOL_COMMAND_MAP: Record<string, string> = {
        pylot_append_and_execute: 'pylot.agent.appendAndExecute',
        pylot_execute_range: 'pylot.agent.executeRange',
        pylot_get_status: 'pylot.agent.getExecutionStatus',
        pylot_evaluate_expression: 'pylot.agent.evaluateExpression',
        pylot_get_output: 'pylot.agent.getOutput',
        pylot_read_file: 'pylot.agent.readFile',
        pylot_edit_code: 'pylot.agent.editCode',
        pylot_restart_repl: 'pylot.agent.restartRepl',
        pylot_interrupt_execution: 'pylot.agent.interruptExecution'
    };

    const mcpSessions = new Map<string, http.ServerResponse>();

    function startMcpHttpServer(port: number) {
        if (mcpHttpServer) { return; }

        mcpHttpServer = http.createServer(async (req, res) => {
            const url = req.url || '/';
            const method = req.method;

            // ── CORS Headers ────────────────────────────────────────────────
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-mcp-protocol-version');

            if (method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }

            logMcpDebug(`[Pylot MCP] Request: ${method} ${url}`);

            // 1. SSE Connection Endpoint
            if (url === '/sse' && method === 'GET') {
                const sessionId = Date.now().toString() + Math.random().toString(36).substring(2, 7);
                logMcpDebug(`[Pylot MCP] Establishing SSE connection (session: ${sessionId})...`);

                // Set socket options for immediate delivery
                req.socket.setNoDelay(true);
                req.socket.setKeepAlive(true);

                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'Access-Control-Allow-Origin': '*'
                });
                res.flushHeaders();

                // Initial endpoint event - include sessionId in the POST URI
                res.write(`event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`);

                mcpSessions.set(sessionId, res);

                // Heartbeat interval to keep connection alive
                const heartbeat = setInterval(() => {
                    if (mcpSessions.get(sessionId) === res) {
                        res.write(': heartbeat\n\n');
                    } else {
                        clearInterval(heartbeat);
                    }
                }, 15000);

                req.on('close', () => {
                    logMcpDebug(`[Pylot MCP] SSE connection closed (session: ${sessionId}).`);
                    clearInterval(heartbeat);
                    if (mcpSessions.get(sessionId) === res) {
                        mcpSessions.delete(sessionId);
                    }
                });
                return;
            }

            // 2. Message (JSON-RPC) Endpoint
            if (url.startsWith('/message') && req.method === 'POST') {
                const urlParsed = new URL(url, `http://localhost:${port}`);
                const sessionId = urlParsed.searchParams.get('sessionId');

                let body = '';
                req.on('data', chunk => { body += chunk.toString(); });
                req.on('end', async () => {
                    logMcpDebug(`[Pylot MCP] POST /message raw body (session: ${sessionId}): ${body}`);
                    try {
                        const msg = JSON.parse(body);
                        const { id, method, params } = msg;

                        if (id === undefined) {
                            res.writeHead(204);
                            res.end();
                            return;
                        }

                        let result: any = null;
                        let error: any = null;

                        switch (method) {
                            case 'initialize':
                                result = {
                                    protocolVersion: params?.protocolVersion || '2024-11-05',
                                    capabilities: { tools: {} },
                                    serverInfo: { name: 'pylot-internal-mcp', version: '1.0.0' }
                                };
                                break;
                            case 'tools/list':
                                result = { tools: MCP_TOOLS };
                                break;
                            case 'tools/call':
                                const toolName = params?.name;
                                const toolArgs = params?.arguments || {};
                                const command = MCP_TOOL_COMMAND_MAP[toolName];
                                if (!command) {
                                    error = { code: -32602, message: `Unknown tool: ${toolName}` };
                                } else {
                                    try {
                                        const cmdResult = await vscode.commands.executeCommand(command, toolArgs);
                                        const text = typeof cmdResult === 'string' ? cmdResult : JSON.stringify(cmdResult, null, 2);
                                        result = { content: [{ type: 'text', text }], isError: false };
                                    } catch (e: any) {
                                        result = { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
                                    }
                                }
                                break;
                            default:
                                // Fallback for the old raw IPC (backward compat)
                                if (MCP_TOOL_COMMAND_MAP[method] || ALLOWED_MCP_COMMANDS.includes(msg.command)) {
                                    const cmd = msg.command || MCP_TOOL_COMMAND_MAP[method];
                                    const args = msg.args || params;
                                    try {
                                        const cmdResult = await vscode.commands.executeCommand(cmd, args);
                                        result = cmdResult;
                                    } catch (e: any) {
                                        error = { code: -32603, message: e.message };
                                    }
                                } else {
                                    error = { code: -32601, message: `Method not found: ${method}` };
                                }
                        }

                        const response: any = { jsonrpc: '2.0', id };
                        if (error) {
                            response.error = error;
                        } else {
                            response.result = result;
                        }

                        const targetSse = sessionId ? mcpSessions.get(sessionId) : Array.from(mcpSessions.values())[0];

                        if (targetSse) {
                            logMcpDebug(`[Pylot MCP] Sending response via SSE (session: ${sessionId || 'fallback'}, id: ${id})`);
                            // Send via SSE
                            targetSse.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);

                            // Return 200 OK with empty body to the POST request
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end('{}');
                        } else {
                            // Fallback for simple HTTP IPC (or if SSE wasn't used/found)
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify(response));
                        }
                    } catch (e: any) {
                        logMcpDebug(`[Pylot MCP] Error processing message: ${e.message}`);
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                });
                return;
            }

            // 3. Fallback for the old simple POST / IPC (legacy)
            if (url === '/' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', async () => {
                    try {
                        const { command, args } = JSON.parse(body);
                        if (!ALLOWED_MCP_COMMANDS.includes(command)) {
                            res.writeHead(403);
                            res.end(JSON.stringify({ error: `Forbidden: ${command}` }));
                            return;
                        }
                        const result = await vscode.commands.executeCommand(command, args);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ result }));
                    } catch (e: any) {
                        res.writeHead(500);
                        res.end(JSON.stringify({ error: e.message }));
                    }
                });
                return;
            }

            res.writeHead(404);
            res.end();
        });

        mcpHttpServer.on('error', (err: any) => {
            outputChannel.appendLine(`[Pylot MCP] HTTP server error: ${err.message}`);
            if (err.code === 'EADDRINUSE') {
                outputChannel.appendLine(`[Pylot MCP] Port ${port} is already in use.`);
            }
        });

        mcpHttpServer.listen(port, () => {
            logMcpDebug(`[Pylot MCP] Internal server listening on port ${port}`);
            logMcpDebug(`[Pylot MCP] SSE endpoint: http://localhost:${port}/sse`);
        });
    }

    function stopMcpHttpServer() {
        if (mcpHttpServer) {
            mcpHttpServer.close();
            mcpHttpServer = null;
            logMcpDebug('[Pylot MCP] HTTP IPC server stopped.');
        }
    }

    // Start MCP server if enabled
    const initialMcpConfig = vscode.workspace.getConfiguration('pylot');
    const isMcpEnabled = initialMcpConfig.get<boolean>('mcpServer.enabled', false);
    const mcpPort = initialMcpConfig.get<number>('mcpServer.port', 7822);

    logMcpDebug(`[Pylot MCP] Checking settings: enabled=${isMcpEnabled}, port=${mcpPort}`);

    if (isMcpEnabled) {
        startMcpHttpServer(mcpPort);
    } else {
        logMcpDebug(`[Pylot MCP] Server is disabled in settings (pylot.mcpServer.enabled).`);
    }

    // React to settings changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('pylot.mcpServer.enabled') || e.affectsConfiguration('pylot.mcpServer.port')) {
                const cfg = vscode.workspace.getConfiguration('pylot');
                const enabled = cfg.get<boolean>('mcpServer.enabled', false);
                const port = cfg.get<number>('mcpServer.port', 7822);
                logMcpDebug(`[Pylot MCP] Settings changed: enabled=${enabled}, port=${port}`);
                stopMcpHttpServer();
                if (enabled) {
                    startMcpHttpServer(port);
                }
            }
            if (e.affectsConfiguration('pylot.debug.python') || e.affectsConfiguration('pylot.debugMode')) {
                debugMode = vscode.workspace.getConfiguration('pylot').get<boolean>('debug.python', false) || vscode.workspace.getConfiguration('pylot').get<boolean>('debugMode', false);
            }
            if (e.affectsConfiguration('pylot.debug.mcpServer') || e.affectsConfiguration('pylot.mcpServer.debugMode')) {
                mcpDebugMode = vscode.workspace.getConfiguration('pylot').get<boolean>('debug.mcpServer', false) || vscode.workspace.getConfiguration('pylot').get<boolean>('mcpServer.debugMode', false);
            }
        })
    );
}

// ── Deactivation ────────────────────────────────────────────────────────────

export function deactivate() {
    if (runningAnimTimer) {
        clearInterval(runningAnimTimer);
    }
    if (pythonRepl) {
        pythonRepl.kill();
    }
    if (mcpHttpServer) {
        mcpHttpServer.close();
        mcpHttpServer = null;
    }
}
