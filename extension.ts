/**
 * Pylot – Python code runner for VS Code
 *
 * Runs selected Python code in a persistent background REPL. The editor acts
 * as the input interface while results appear in a dedicated output panel.
 * Execution state (running / success / error) is shown via gutter markers.
 *
 * Communication protocol with the REPL wrapper:
 *   <<<PYLOT_READY>>>              – REPL is initialised and ready
 *   <<<PYLOT_SUCCESS>>>            – code block executed successfully
 *   <<<PYLOT_ERROR>>>              – code block raised an exception
 *   <<<PYLOT_TYPE:<typename>>>>    – type of the last evaluated expression
 */

import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

// ── Types ───────────────────────────────────────────────────────────────────

/** Subset of the Python extension API used for interpreter discovery. */
interface PythonExtensionApi {
    environments: {
        getActiveEnvironmentPath(): { path: string } | undefined;
    };
}

// ── Module-level state ──────────────────────────────────────────────────────

let pythonRepl: ChildProcess | null = null;
let replReady = false;
let currentPythonPath: string | undefined = undefined;
let currentExecutionCallback: ((success: boolean) => void) | null = null;
let expressionResultCallback: ((result: string) => void) | null = null;
let outputChannel: vscode.OutputChannel;
let lastExpressionResult: string = '';
let lastExpressionType: string = '';
const DEBUG_MODE = false;

// ── Activation ──────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    vscode.commands.executeCommand('setContext', 'pylotMarkerActive', true);

    outputChannel = vscode.window.createOutputChannel("pylot");

    // ── Gutter decoration SVGs ──────────────────────────────────────────

    const runningSvg = `data:image/svg+xml;utf8,
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 10" preserveAspectRatio="none">
            <rect x="2" y="0" width="0.75" height="10" fill="rgb(255, 165, 0)">
                <animate attributeName="fill-opacity"
                         values="0.5;1;0.5"
                         dur="2s"
                         repeatCount="indefinite"
                         calcMode="spline"
                         keyTimes="0;0.5;1"
                         keySplines="0.42 0 0.58 1;0.42 0 0.58 1" />
            </rect>
        </svg>`;

    const executedSvg = `data:image/svg+xml;utf8,
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 10" preserveAspectRatio="none">
            <rect x="2" y="0" width="0.75" height="10" fill="rgb(0, 255, 0)" fill-opacity="0.8" />
        </svg>`;

    const errorSvg = `data:image/svg+xml;utf8,
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 10" preserveAspectRatio="none">
            <rect x="2" y="0" width="0.75" height="10" fill="rgb(255, 0, 0)" fill-opacity="0.8" />
        </svg>`;

    const runningDecoration = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.parse(runningSvg),
        gutterIconSize: 'contain',
        isWholeLine: true
    });
    const executedDecoration = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.parse(executedSvg),
        gutterIconSize: 'contain',
        isWholeLine: true
    });
    const errorDecoration = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.parse(errorSvg),
        gutterIconSize: 'contain',
        isWholeLine: true
    });

    // ── Python interpreter discovery ────────────────────────────────────

    /** Resolve the active Python interpreter via the ms-python extension. */
    async function getPythonPath(): Promise<string | undefined> {
        const pythonExtension = vscode.extensions.getExtension<PythonExtensionApi>('ms-python.python');
        if (!pythonExtension) {
            vscode.window.showErrorMessage('The Python extension (ms-python.python) is required for this feature. Please install it.');
            return undefined;
        }

        if (!pythonExtension.isActive) {
            await pythonExtension.activate();
        }

        const environment = pythonExtension.exports.environments.getActiveEnvironmentPath();
        if (!environment?.path) {
            vscode.window.showErrorMessage('No Python interpreter selected. Please select an interpreter using the "Python: Select Interpreter" command.');
            return undefined;
        }

        return environment.path;
    }

    // ── REPL management ─────────────────────────────────────────────────

    /**
     * Python bootstrap script injected into the REPL process.
     *
     * It reads JSON commands from stdin, executes them in a persistent
     * namespace, and communicates results back via stdout markers.
     * A background thread reads stdin so the main loop can also pump
     * Matplotlib GUI events between commands.
     */
    const replWrapperCode = `
import sys, json, traceback, os
import threading
import queue

# Markers used to communicate execution results back to VS Code
READY_MARKER = "<<<PYLOT_READY>>>"
ERROR_MARKER = "<<<PYLOT_ERROR>>>"
SUCCESS_MARKER = "<<<PYLOT_SUCCESS>>>"
TYPE_MARKER = "<<<PYLOT_TYPE:"

print(READY_MARKER, flush=True)

# Persistent global namespace shared across all executed code blocks
persistent_globals = {'__name__': '__main__', '__doc__': None}

input_queue = queue.Queue()
mpl_mode = os.environ.get('PYLOT_MPL_MODE', 'auto')

def force_patch_matplotlib():
    """Enable interactive mode and make plt.show() non-blocking."""
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
    """Flush GUI events for all open Matplotlib figures."""
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
            input_queue.put(line)
        except Exception:
            break

stdin_thread = threading.Thread(target=read_stdin, daemon=True)
stdin_thread.start()

while True:
    try:
        # Wait briefly for input, pumping GUI events in the meantime
        try:
            line = input_queue.get(timeout=0.05)
            if line is None:
                break
        except queue.Empty:
            if mpl_mode != 'never':
                pump_events()
            continue

        command = json.loads(line.strip())
        code = command['code']
        filename = command['filename']
        start_line = command['start_line']

        adjusted_code = json.loads(code)

        # Auto-patch Matplotlib when the keyword is detected
        if mpl_mode == 'auto' and 'matplotlib' in adjusted_code:
            force_patch_matplotlib()

        # Determine whether the code is an expression or a statement
        is_expression = False
        try:
            compiled = compile(adjusted_code, filename, 'eval')
            is_expression = True
        except SyntaxError:
            is_expression = False

        try:
            if is_expression:
                result = eval(adjusted_code, persistent_globals)
                if result is not None:
                    print(repr(result), flush=True)
                    print(TYPE_MARKER + type(result).__name__ + ">>>", flush=True)
            else:
                compiled = compile(adjusted_code, filename, 'exec')
                exec(compiled, persistent_globals)

            print(SUCCESS_MARKER, flush=True)
        except Exception:
            traceback.print_exc(file=sys.stderr)
            print(ERROR_MARKER, flush=True)

    except Exception:
        traceback.print_exc(file=sys.stderr)
        print(ERROR_MARKER, flush=True)
`;

    /**
     * Spawn a new persistent Python REPL process.
     * Resolves `true` once the REPL prints its READY marker, or `false` on
     * timeout / error.
     */
    async function startRepl(pythonPath: string): Promise<boolean> {
        return new Promise((resolve) => {
            try {

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

                const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

                pythonRepl = spawn(pythonPath, ['-u', '-c', replWrapperCode], {
                    env: env,
                    cwd: cwd
                });

                replReady = false;
                currentPythonPath = pythonPath;

                let stdoutBuffer = '';

                pythonRepl.stdout?.on('data', (data) => {
                    const text = data.toString();
                    stdoutBuffer += text;

                    // REPL startup complete
                    if (stdoutBuffer.includes('<<<PYLOT_READY>>>')) {
                        replReady = true;
                        stdoutBuffer = stdoutBuffer.replace(/<<<PYLOT_READY>>>\r?\n?/g, '');
                        if (!resolve) return;
                        const tempResolve = resolve;
                        resolve = null as any;
                        tempResolve(true);
                    }

                    // Successful execution
                    if (stdoutBuffer.includes('<<<PYLOT_SUCCESS>>>')) {
                        // Extract expression type if present
                        let expressionType = '';
                        const typeMatchResult = stdoutBuffer.match(/<<<PYLOT_TYPE:([a-zA-Z_0-9]+)>>>/);
                        if (typeMatchResult) {
                            expressionType = typeMatchResult[1];
                        }

                        // Strip protocol markers, preserving user output
                        let cleanedBuffer = stdoutBuffer;
                        cleanedBuffer = cleanedBuffer.replace(/<<<PYLOT_TYPE:[^>]+>>>[\r\n]*/g, '');
                        cleanedBuffer = cleanedBuffer.replace(/<<<PYLOT_SUCCESS>>>[\r\n]*/g, '');

                        const normalOutput = cleanedBuffer;
                        const popupOutput = cleanedBuffer.replace(/[\r\n]+/g, ' ').trim();

                        lastExpressionType = expressionType;

                        if (expressionResultCallback) {
                            expressionResultCallback(popupOutput);
                            expressionResultCallback = null;
                        } else if (normalOutput) {
                            outputChannel.append(normalOutput);
                        }

                        if (currentExecutionCallback) {
                            currentExecutionCallback(true);
                            currentExecutionCallback = null;
                        }
                        stdoutBuffer = '';
                    }

                    // Failed execution
                    if (stdoutBuffer.includes('<<<PYLOT_ERROR>>>')) {
                        stdoutBuffer = stdoutBuffer.replace(/<<<PYLOT_ERROR>>>\r?\n?/g, '');

                        const errorResult = stdoutBuffer.trim();
                        if (errorResult && expressionResultCallback) {
                            expressionResultCallback(errorResult);
                            expressionResultCallback = null;
                        } else if (stdoutBuffer) {
                            outputChannel.append(stdoutBuffer);
                        }

                        if (currentExecutionCallback) {
                            currentExecutionCallback(false);
                            currentExecutionCallback = null;
                        }
                        stdoutBuffer = '';
                    }

                    // Forward any remaining buffered output
                    if (stdoutBuffer) {
                        outputChannel.append(stdoutBuffer);
                        stdoutBuffer = '';
                    }
                });

                pythonRepl.stderr?.on('data', (data) => {
                    outputChannel.append(data.toString());
                });

                pythonRepl.on('close', (code) => {
                    pythonRepl = null;
                    replReady = false;
                    outputChannel.appendLine(`[REPL process closed with code ${code}]`);
                });

                pythonRepl.on('error', (err) => {
                    outputChannel.appendLine(`[ERROR] Failed to start REPL: ${err.message}`);
                    pythonRepl = null;
                    replReady = false;
                    if (resolve) {
                        const tempResolve = resolve;
                        resolve = null as any;
                        tempResolve(false);
                    }
                });

                // Timeout if REPL doesn't become ready
                setTimeout(() => {
                    if (resolve) {
                        const tempResolve = resolve;
                        resolve = null as any;
                        tempResolve(false);
                    }
                }, 5000);

            } catch (err: any) {
                outputChannel.appendLine(`[ERROR] Exception starting REPL: ${err.message}`);
                resolve(false);
            }
        });
    }

    /** Kill the REPL process if it is running. */
    function stopRepl() {
        if (pythonRepl) {
            pythonRepl.kill();
            pythonRepl = null;
            replReady = false;
        }
    }

    // ── Gutter decoration helpers ───────────────────────────────────────

    /** Clear all Pylot gutter decorations from every visible Python editor. */
    function removeAllColorMarks() {
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.languageId === 'python') {
                editor.setDecorations(runningDecoration, []);
                editor.setDecorations(executedDecoration, []);
                editor.setDecorations(errorDecoration, []);
            }
        }
    }

    // ── Code execution ──────────────────────────────────────────────────

    /**
     * Send a code block to the REPL and track its execution via gutter
     * decorations. Resolves with `{ success, executed }`.
     */
    function executeInRepl(command: any, editor: vscode.TextEditor, trimmedRange: vscode.Range, canExecute: boolean): Promise<{ success: boolean; executed: boolean }> {
        return new Promise((resolve) => {
            if (!canExecute) {
                resolve({ success: false, executed: false });
                return;
            }

            editor.setDecorations(runningDecoration, [trimmedRange]);
            editor.setDecorations(executedDecoration, []);
            editor.setDecorations(errorDecoration, []);

            currentExecutionCallback = (execSuccess: boolean) => {
                resolve({ success: execSuccess, executed: true });
            };

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
    function getTopBlock(selectionRange: any, document: vscode.TextDocument): vscode.Range {
        const { firstCodeLine, lastCodeLine } = getCodeBounds(document);
        let current = selectionRange;
        let blockRange = current.range;

        while (current.parent) {
            const parentRange = current.parent.range;
            // Stop before selecting the entire file
            if (parentRange.start.line <= firstCodeLine && parentRange.end.line >= lastCodeLine) {
                break;
            }
            blockRange = parentRange;
            current = current.parent;
        }
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
     * updates gutter decorations and cursor position.
     *
     * @param moveCursor If true, advance the cursor past the executed block.
     */
    async function executeSelectedPython(editor: vscode.TextEditor, moveCursor: boolean): Promise<void> {
        const pythonPath = await getPythonPath();
        if (!pythonPath) { return; }

        // Start REPL if not running or if the interpreter changed
        if (!pythonRepl || !replReady || currentPythonPath !== pythonPath || DEBUG_MODE) {
            stopRepl();
            outputChannel.clear();
            outputChannel.show(true);

            const success = await startRepl(pythonPath);
            if (!success) {
                vscode.window.showErrorMessage('Failed to start Python REPL. See "pylot" in Output.');
                return;
            }
        } else {
            outputChannel.show(true);
        }

        // Require the language server to be active so smart selection works
        const symbols: any = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', editor.document.uri);
        if (!symbols || symbols.length === 0) {
            return;
        }

        let initialStartLine = editor.selection.start.line;
        let initialEndLine = editor.selection.end.line;

        // If the selection ends at column 0 of a line, exclude that line
        if (!editor.selection.isEmpty && editor.selection.end.character === 0 && initialEndLine > initialStartLine) {
            initialEndLine--;
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

        // ── Empty-line handling ─────────────────────────────────────────
        // When the trimmed range contains no executable code, either expand
        // to the enclosing block (if the cursor is inside one) or skip to
        // the next executable line.
        if (initialStartLine > initialEndLine) {
            let isInnerBlock = false;

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
                return;
            }
        }

        // ── Standard smart-selection expansion ──────────────────────────
        // Use the language server's SelectionRangeProvider to expand the
        // selection to the nearest top-level statement/block.
        if (!executionSelection) {
            try {
                const queryStart = new vscode.Position(initialStartLine, editor.document.lineAt(initialStartLine).firstNonWhitespaceCharacterIndex);
                const queryEnd = new vscode.Position(initialEndLine, editor.document.lineAt(initialEndLine).firstNonWhitespaceCharacterIndex);

                const ranges: any = await vscode.commands.executeCommand('vscode.executeSelectionRangeProvider', editor.document.uri, [queryStart, queryEnd]);

                if (!ranges || ranges.length === 0) {
                    return;
                }

                const startBlockRange = getTopBlock(ranges[0], editor.document);
                const endBlockRange = ranges.length > 1 ? getTopBlock(ranges[1], editor.document) : startBlockRange;

                executionSelection = new vscode.Selection(startBlockRange.start, endBlockRange.end);
            } catch (e) {
                return;
            }
        }

        if (executionSelection.isEmpty) {
            return;
        }

        // ── Build and send the command ──────────────────────────────────

        const code = editor.document.getText(executionSelection);
        const command = {
            code: JSON.stringify(code),
            filename: editor.document.fileName,
            start_line: executionSelection.start.line + 1
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
            const targetLine = findNextExecutableLine(editor.document, executionSelection.end.line + 1);
            if (targetLine >= 0) {
                moveCursorToLine(editor, targetLine);
            }
        }

        const result = await executeInRepl(command, editor, trimmedRange, canExecute);

        // ── Update gutter decorations ───────────────────────────────────

        if (result.executed) {
            editor.setDecorations(runningDecoration, []);
            if (result.success) {
                editor.setDecorations(executedDecoration, [trimmedRange]);
            } else {
                editor.setDecorations(errorDecoration, [trimmedRange]);
                // On error, collapse the selection so the error range stays visible
                const emptySelection = new vscode.Selection(originalSelection.active, originalSelection.active);
                editor.selection = emptySelection;
                editor.revealRange(emptySelection);
            }
        } else {
            const emptySelection = new vscode.Selection(originalSelection.active, originalSelection.active);
            editor.selection = emptySelection;
            editor.revealRange(emptySelection);
        }
    }

    // ── Expression evaluation ───────────────────────────────────────────

    /**
     * Spawn a short-lived Python process to check whether `code` can be
     * compiled as an expression (eval) rather than a statement (exec).
     */
    async function isValidPythonExpression(code: string): Promise<boolean> {
        const pythonPath = await getPythonPath();
        if (!pythonPath) { return false; }

        return new Promise((resolve) => {
            try {
                const checkScript = `import sys; code = sys.stdin.read();
try:
    compile(code, '<string>', 'eval')
    print('VALID')
except SyntaxError:
    print('INVALID')`;

                const proc = spawn(pythonPath, ['-c', checkScript], {
                    stdio: ['pipe', 'pipe', 'pipe']
                });

                let stdout = '';

                proc.stdout?.on('data', (data) => {
                    stdout += data.toString();
                });

                proc.on('close', () => {
                    resolve(stdout.trim() === 'VALID');
                });

                proc.on('error', () => {
                    resolve(false);
                });

                proc.stdin?.write(code);
                proc.stdin?.end();

                setTimeout(() => {
                    proc.kill();
                    resolve(false);
                }, 2000);

            } catch {
                resolve(false);
            }
        });
    }

    // ── Shared webview CSS ──────────────────────────────────────────────

    /** Base CSS used by both the success and error expression popups. */
    const webviewBaseCss = `
        body {
            font-family: 'Consolas', 'Courier New', monospace;
            padding: 20px;
            background-color: #1e1e1e;
            color: #d4d4d4;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
        }
        .expression-box {
            background-color: #2d2d2d;
            padding: 10px;
            border-radius: 4px;
            overflow-x: auto;
            max-height: 60px;
            overflow-y: auto;
        }
        .result-box {
            background-color: #2d2d2d;
            padding: 15px;
            border-radius: 4px;
            max-height: 200px;
            overflow-y: auto;
        }
        button {
            margin-top: 20px;
            padding: 8px 16px;
            background-color: #0e639c;
            color: white;
            border: none;
            border-radius: 2px;
            cursor: pointer;
        }
        button:hover {
            background-color: #1177bb;
        }`;

    /** Webview close-button script shared by both popup types. */
    const webviewCloseScript = `
        <script>
            const vscode = acquireVsCodeApi();
            document.querySelector('button').addEventListener('click', () => {
                vscode.postMessage({ command: 'close' });
            });
        </script>`;

    /** Escape HTML special characters for safe embedding in webview. */
    function escapeHtml(text: string): string {
        return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ── Command registrations ───────────────────────────────────────────

    const restartReplCommand = vscode.commands.registerCommand('pylot.restartRepl', async () => {
        removeAllColorMarks();
        stopRepl();
        const pythonPath = await getPythonPath();
        if (!pythonPath) { return; }

        outputChannel.clear();
        outputChannel.show(true);
        outputChannel.appendLine('[Restarting Python REPL...]');

        const success = await startRepl(pythonPath);
        if (success) {
            outputChannel.appendLine('[REPL ready]');
            vscode.window.showInformationMessage('Python REPL restarted successfully.');
        } else {
            vscode.window.showErrorMessage('Failed to restart Python REPL.');
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

    const clearOutputCommand = vscode.commands.registerCommand('pylot.clearOutput', () => {
        outputChannel.clear();
    });

    const removeColorMarksCommand = vscode.commands.registerCommand('pylot.removeColorMarks', () => {
        removeAllColorMarks();
        vscode.window.showInformationMessage('All Pylot color marks removed.');
    });

    const evaluateExpressionCommand = vscode.commands.registerCommand('pylot.evaluateExpression', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return; }

        const selection = editor.selection;
        if (selection.isEmpty) {
            vscode.window.showInformationMessage('No expression selected');
            return;
        }

        const code = editor.document.getText(selection).trim();
        if (!code) {
            vscode.window.showInformationMessage('No expression selected');
            return;
        }

        const isExpression = await isValidPythonExpression(code);
        if (!isExpression) {
            vscode.window.showInformationMessage('Selection is not a valid expression (statements cannot be evaluated)');
            return;
        }

        const pythonPath = await getPythonPath();
        if (!pythonPath) { return; }

        // Start REPL if not running or if the interpreter changed
        if (!pythonRepl || !replReady || currentPythonPath !== pythonPath || DEBUG_MODE) {
            stopRepl();
            outputChannel.clear();
            outputChannel.show(true);

            const success = await startRepl(pythonPath);
            if (!success) {
                vscode.window.showErrorMessage('Failed to start Python REPL. See "pylot" in Output.');
                return;
            }
        }

        lastExpressionResult = '';
        lastExpressionType = '';

        const command = {
            code: JSON.stringify(code),
            filename: editor.document.fileName,
            start_line: selection.start.line + 1
        };

        const result = await new Promise<{ success: boolean; executed: boolean }>((resolve) => {
            if (!pythonRepl || !replReady) {
                resolve({ success: false, executed: false });
                return;
            }

            expressionResultCallback = (resultText: string) => {
                lastExpressionResult = resultText;
            };

            currentExecutionCallback = (execSuccess: boolean) => {
                resolve({ success: execSuccess, executed: true });
            };

            pythonRepl.stdin?.write(JSON.stringify(command) + '\n');
        });

        // ── Show result / error in a webview popup ──────────────────

        const escapedCode = escapeHtml(code);

        if (result.success) {
            const panel = vscode.window.createWebviewPanel(
                'pylotExpressionResult',
                'Expression Result',
                vscode.ViewColumn.One,
                { enableScripts: true, retainContextWhenHidden: true }
            );

            const resultHtml = lastExpressionResult && lastExpressionResult.trim()
                ? `<div class="label">Result:</div>
                   <div class="result-box" style="color: #4ec9b0;">${escapeHtml(lastExpressionResult)}</div>`
                : `<div class="label">Result:</div>
                   <div class="result-box" style="color: #808080; font-style: italic;">Expression evaluated successfully (no output)</div>`;

            panel.webview.html = `
                <!DOCTYPE html>
                <html>
                <head>
                    <style>
                        ${webviewBaseCss}
                        h2 { color: #569cd6; border-bottom: 1px solid #3c3c3c; padding-bottom: 10px; }
                        .label { font-weight: bold; margin-bottom: 5px; margin-top: 15px; }
                        .type-box { color: #9cdcfe; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h2>Expression Result</h2>
                        <div class="label">Expression:</div>
                        <div class="expression-box">${escapedCode}</div>
                        ${lastExpressionType ? `<div class="label type-box">Type: ${lastExpressionType}</div>` : ''}
                        ${resultHtml}
                        <button onclick="vscode.postMessage({ command: 'close' })">Close</button>
                    </div>
                    ${webviewCloseScript}
                </body>
                </html>`;

            panel.webview.onDidReceiveMessage((message) => {
                if (message.command === 'close') { panel.dispose(); }
            });
        } else {
            const panel = vscode.window.createWebviewPanel(
                'pylotExpressionError',
                'Expression Error',
                vscode.ViewColumn.One,
                { enableScripts: true, retainContextWhenHidden: true }
            );

            panel.webview.html = `
                <!DOCTYPE html>
                <html>
                <head>
                    <style>
                        ${webviewBaseCss}
                        h2 { color: #f44747; border-bottom: 1px solid #3c3c3c; padding-bottom: 10px; }
                        .error { background-color: #2d2d2d; padding: 15px; border-radius: 4px; color: #f44747; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h2>Expression Evaluation Failed</h2>
                        <div class="expression-box" style="margin-bottom: 20px;">
                            <strong>Expression:</strong><br>
                            ${escapedCode}
                        </div>
                        <div class="error">Check the "pylot" output channel for details.</div>
                        <button onclick="vscode.postMessage({ command: 'close' })">Close</button>
                    </div>
                    ${webviewCloseScript}
                </body>
                </html>`;

            panel.webview.onDidReceiveMessage((message) => {
                if (message.command === 'close') { panel.dispose(); }
            });
        }
    });

    context.subscriptions.push(executeCommand);
    context.subscriptions.push(executeNoMoveCommand);
    context.subscriptions.push(restartReplCommand);
    context.subscriptions.push(clearOutputCommand);
    context.subscriptions.push(removeColorMarksCommand);
    context.subscriptions.push(evaluateExpressionCommand);
}

// ── Deactivation ────────────────────────────────────────────────────────────

export function deactivate() {
    if (pythonRepl) {
        pythonRepl.kill();
    }
}
