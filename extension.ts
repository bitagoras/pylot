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
let validationCallback: ((isValid: boolean) => void) | null = null;
let outputChannel: vscode.OutputChannel;
let lastExpressionResult: string = '';
let lastExpressionType: string = '';
let lastExpressionShape: string = '';
let lastExpressionLen: string = '';
let asyncExpressionResultCallback: ((success: boolean, resultText: string, type: string, shape: string, len: string) => void) | null = null;
const DEBUG_MODE = false;
let silentEvaluation = false;
let runningAnimTimer: ReturnType<typeof setInterval> | null = null;

// ── Timeout constants ───────────────────────────────────────────────────────

/** Maximum time (ms) to wait for the REPL to print its ready message. */
const REPL_STARTUP_TIMEOUT_MS = 5000;

/** Maximum time (ms) to wait for expression validation via the REPL. */
const VALIDATION_TIMEOUT_MS = 2000;

/** Interval (s) between Matplotlib GUI event pumps in the REPL loop. */
const MPL_EVENT_PUMP_INTERVAL_S = 0.05;

// ── Activation ──────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    vscode.commands.executeCommand('setContext', 'pylotMarkerActive', true);

    outputChannel = vscode.window.createOutputChannel("pylot");

    // ── Line decorations (left-border style) ─────────────────────────────
    //
    // Uses coloured left borders instead of gutter icons so they don't
    // conflict with breakpoints.  The running state is animated via a
    // timer that cycles through pre-built opacity frames.

    const RUNNING_FRAMES = 20;
    const RUNNING_INTERVAL_MS = 100;
    const runningFrames: vscode.TextEditorDecorationType[] = [];

    for (let i = 0; i < RUNNING_FRAMES; i++) {
        const opacity = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin((i / RUNNING_FRAMES) * 2 * Math.PI));
        runningFrames.push(vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            borderWidth: '0 0 0 4px',
            borderStyle: 'ridge',
            borderColor: `rgba(255, 165, 0, ${opacity.toFixed(2)})`,
            overviewRulerColor: 'rgba(255, 165, 0, 0.8)',
            overviewRulerLane: vscode.OverviewRulerLane.Left,
        }));
    }

    let runningAnimEditor: vscode.TextEditor | null = null;
    let runningAnimRanges: vscode.Range[] = [];
    let runningAnimFrame = 0;

    function startRunningAnimation(editor: vscode.TextEditor, ranges: vscode.Range[]) {
        stopRunningAnimation();
        runningAnimEditor = editor;
        runningAnimRanges = ranges;
        runningAnimFrame = 0;

        // Show the first frame immediately
        editor.setDecorations(runningFrames[0], ranges);

        runningAnimTimer = setInterval(() => {
            if (!runningAnimEditor) { return; }
            // Hold a reference to the previous frame
            const previousFrame = runningAnimFrame;

            // Advance to the new frame and show it first
            runningAnimFrame = (runningAnimFrame + 1) % RUNNING_FRAMES;
            runningAnimEditor.setDecorations(runningFrames[runningAnimFrame], runningAnimRanges);

            // Now safely clear the previous frame after the new one is already active
            runningAnimEditor.setDecorations(runningFrames[previousFrame], []);
        }, RUNNING_INTERVAL_MS);
    }

    function stopRunningAnimation() {
        if (runningAnimTimer) {
            clearInterval(runningAnimTimer);
            runningAnimTimer = null;
        }
        if (runningAnimEditor) {
            for (let i = 0; i < RUNNING_FRAMES; i++) {
                runningAnimEditor.setDecorations(runningFrames[i], []);
            }
        }
        runningAnimEditor = null;
        runningAnimRanges = [];
    }

    const executedDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        borderWidth: '0 0 0 4px',
        borderStyle: 'ridge',
        borderColor: 'rgba(0, 255, 0, 0.6)',
        overviewRulerColor: 'rgba(0, 255, 0, 0.6)',
        overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    const errorDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        borderWidth: '0 0 0 4px',
        borderStyle: 'ridge',
        borderColor: 'rgba(255, 0, 0, 0.6)',
        overviewRulerColor: 'rgba(255, 0, 0, 0.6)',
        overviewRulerLane: vscode.OverviewRulerLane.Left,
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
     * namespace, and communicates results back via stdout JSON messages.
     * A background thread reads stdin so the main loop can also pump
     * Matplotlib GUI events between commands.
     */
    const replWrapperCode = `
import sys, json, traceback, os
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

send_msg('ready')

persistent_globals = {'__name__': '__main__', '__doc__': None}
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

        adjusted_code = json.loads(code)

        if action == 'validate':
            try:
                compile(adjusted_code, '<string>', 'eval')
                send_msg('validate', valid=True)
            except SyntaxError:
                send_msg('validate', valid=False)
            continue

        filename = command['filename']
        start_line = command['start_line']

        if mpl_mode == 'auto' and 'matplotlib' in adjusted_code:
            force_patch_matplotlib()

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
                else:
                    send_msg('execute', success=True)
            else:
                compiled = compile(adjusted_code, filename, 'exec')
                exec(compiled, persistent_globals)
                send_msg('execute', success=True)
        except KeyboardInterrupt:
            print("\\nKeyboardInterrupt", file=sys.stderr)
            send_msg('execute', success=False)
        except Exception:
            traceback.print_exc(file=sys.stderr)
            send_msg('execute', success=False)

    except KeyboardInterrupt:
        print("\\nKeyboardInterrupt", file=sys.stderr)
        send_msg('execute', success=False)
    except Exception:
        traceback.print_exc(file=sys.stderr)
        send_msg('execute', success=False)
`;

    /**
     * Spawn a new persistent Python REPL process.
     * Resolves `true` once the REPL prints its ready message, or `false` on
     * timeout / error.
     */
    async function startRepl(pythonPath: string): Promise<boolean> {
        return new Promise((resolve) => {
            let resolved = false;
            const resolveOnce = (value: boolean) => {
                if (resolved) return;
                resolved = true;
                resolve(value);
            };

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
                                    outputChannel.append(userOutput);
                                }
                            }
                            const jsonStr = line.substring(markerIndex + '<<<PYLOT_JSON>>>'.length).trim();
                            try {
                                const msg = JSON.parse(jsonStr);

                                switch (msg.type) {
                                    case 'ready':
                                        replReady = true;
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
                                            if (currentExecutionCallback) {
                                                currentExecutionCallback(false);
                                                currentExecutionCallback = null;
                                            }
                                        }
                                        break;
                                }
                            } catch (e) {
                                // Fallback for invalid JSON
                            }
                        } else {
                            if (!silentEvaluation) {
                                outputChannel.append(line);
                            }
                        }
                    }
                });

                pythonRepl.stderr?.on('data', (data) => {
                    if (!silentEvaluation) {
                        outputChannel.append(data.toString());
                    }
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
                    resolveOnce(false);
                });

                // Timeout if REPL doesn't become ready
                setTimeout(() => {
                    resolveOnce(false);
                }, REPL_STARTUP_TIMEOUT_MS);

            } catch (err: any) {
                outputChannel.appendLine(`[ERROR] Exception starting REPL: ${err.message}`);
                resolveOnce(false);
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

    // ── Line decoration helpers ─────────────────────────────────────────

    /** Clear all Pylot line decorations from every visible Python editor. */
    function removeAllColorMarks() {
        stopRunningAnimation();
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.languageId === 'python') {
                for (let i = 0; i < RUNNING_FRAMES; i++) {
                    editor.setDecorations(runningFrames[i], []);
                }
                editor.setDecorations(executedDecoration, []);
                editor.setDecorations(errorDecoration, []);
            }
        }
    }

    // ── Code execution ──────────────────────────────────────────────────

    /**
     * Send a code block to the REPL and track its execution via line
     * decorations. Resolves with `{ success, executed }`.
     */
    function executeInRepl(command: any, editor: vscode.TextEditor, trimmedRange: vscode.Range, canExecute: boolean): Promise<{ success: boolean; executed: boolean }> {
        return new Promise((resolve) => {
            if (!canExecute) {
                resolve({ success: false, executed: false });
                return;
            }

            editor.setDecorations(executedDecoration, []);
            editor.setDecorations(errorDecoration, []);
            startRunningAnimation(editor, [trimmedRange]);

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
     * updates line decorations and cursor position.
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

        // ── Update line decorations ──────────────────────────────────────

        if (result.executed) {
            stopRunningAnimation();
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

        // Validate via the REPL (requires REPL to be running)
        const isExpression = await isValidPythonExpression(code);
        if (!isExpression) {
            return;
        }

        lastExpressionResult = '';
        lastExpressionType = '';
        lastExpressionShape = '';
        lastExpressionLen = '';

        const command = {
            action: 'evaluate_async',
            code: JSON.stringify(code),
            filename: editor.document.fileName,
            start_line: selection.start.line + 1
        };

        const result = await new Promise<{ success: boolean; executed: boolean }>((resolve) => {
            if (!pythonRepl || !replReady) {
                resolve({ success: false, executed: false });
                return;
            }

            asyncExpressionResultCallback = (success: boolean, resultText: string, type: string, shape: string, len: string) => {
                lastExpressionResult = resultText;
                lastExpressionType = type;
                lastExpressionShape = shape;
                lastExpressionLen = len;
                resolve({ success: success, executed: true });
            };

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

            const command = {
                action: 'evaluate_async',
                code: JSON.stringify(expressionToEvaluate),
                filename: document.fileName,
                start_line: position.line + 1
            };

            const evalResult = await new Promise<{ success: boolean; executed: boolean }>((resolve) => {
                asyncExpressionResultCallback = (success: boolean, resultText: string, type: string, shape: string, len: string) => {
                    lastExpressionResult = resultText;
                    lastExpressionType = type;
                    lastExpressionShape = shape;
                    lastExpressionLen = len;
                    resolve({ success: success, executed: true });
                };

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

    context.subscriptions.push(hoverProvider);
    context.subscriptions.push(executeCommand);
    context.subscriptions.push(executeNoMoveCommand);
    context.subscriptions.push(restartReplCommand);
    context.subscriptions.push(clearOutputCommand);
    context.subscriptions.push(removeColorMarksCommand);
    context.subscriptions.push(evaluateExpressionCommand);
    context.subscriptions.push(interruptCommand);
}

// ── Deactivation ────────────────────────────────────────────────────────────

export function deactivate() {
    if (runningAnimTimer) {
        clearInterval(runningAnimTimer);
    }
    if (pythonRepl) {
        pythonRepl.kill();
    }
}
