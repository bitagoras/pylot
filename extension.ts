import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

// A type definition for the Python extension's API
interface PythonExtensionApi {
    environments: {
        getActiveEnvironmentPath(): { path: string } | undefined;
    };
}

// Module-level variables for persistent REPL
let pythonRepl: ChildProcess | null = null;
let replReady = false;
let currentPythonPath: string | undefined = undefined;
let currentExecutionCallback: ((success: boolean) => void) | null = null;
let expressionResultCallback: ((result: string) => void) | null = null;
let outputChannel: vscode.OutputChannel;
let lastExpressionResult: string = '';
let lastExpressionType: string = '';
    const DEBUG_MODE = false; // Toggle this to enable debug mode

export function activate(context: vscode.ExtensionContext) {
    vscode.commands.executeCommand('setContext', 'pylotMarkerActive', true);

    // Create a single, reusable output channel
    outputChannel = vscode.window.createOutputChannel("pylot");

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

    // Create the Decoration Types for each state
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

    // Helper function to get the Python path
    async function getPythonPath(): Promise<string | undefined> {
        const pythonExtension = vscode.extensions.getExtension<PythonExtensionApi>('ms-python.python');
        if (!pythonExtension) {
            vscode.window.showErrorMessage('The Python extension (ms-python.python) is required for this feature. Please install it.');
            return undefined;
        }

        if (!pythonExtension.isActive) {
            await pythonExtension.activate();
        }

        const pythonApi = pythonExtension.exports;
        const environment = pythonApi.environments.getActiveEnvironmentPath();
        if (!environment?.path) {
            vscode.window.showErrorMessage('No Python interpreter selected. Please select an interpreter using the "Python: Select Interpreter" command.');
            return undefined;
        }

        return environment.path;
    }

    // Persistent REPL wrapper code
    const replWrapperCode = `
import sys, json, traceback
import threading
import queue

# Marker to indicate readiness
READY_MARKER = "<<<PYLOT_READY>>>"
ERROR_MARKER = "<<<PYLOT_ERROR>>>"
SUCCESS_MARKER = "<<<PYLOT_SUCCESS>>>"
TYPE_MARKER = "<<<PYLOT_TYPE:"

# Signal that we're ready to receive commands
print(READY_MARKER, flush=True)

# Keep a persistent global namespace, properly initialized
persistent_globals = {'__name__': '__main__', '__doc__': None}

# Use a queue and a background thread to read stdin
# This allows the main thread to remain unblocked to pump GUI events
input_queue = queue.Queue()

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

# Start background thread to listen for VS Code commands
stdin_thread = threading.Thread(target=read_stdin, daemon=True)
stdin_thread.start()

while True:
    try:
        # 1. Wait for input with a small timeout to allow UI updates
        try:
            line = input_queue.get(timeout=0.05)
            if line is None:
                break # EOF reached
        except queue.Empty:
            # 2. Check if matplotlib is loaded and pump its events safely
            if 'matplotlib.pyplot' in sys.modules:
                try:
                    plt = sys.modules['matplotlib.pyplot']

                    # Initialize our patches once
                    if not getattr(plt, '_pylot_patched', False):
                        plt.ion() # Automatically enable interactive mode

                        # Monkey-patch plt.show to always be non-blocking natively
                        original_show = plt.show
                        def non_blocking_show(*args, **kwargs):
                            kwargs['block'] = False
                            original_show(*args, **kwargs)
                        plt.show = non_blocking_show

                        plt._pylot_patched = True

                    # Quietly pump events for all open figures without stealing focus
                    if hasattr(plt, '_pylab_helpers'):
                        for manager in plt._pylab_helpers.Gcf.get_all_fig_managers():
                            if hasattr(manager.canvas, 'flush_events'):
                                manager.canvas.flush_events()
                except Exception:
                    pass # Safely ignore errors during event pumping
            continue

        command = json.loads(line.strip())
        code = command['code']
        filename = command['filename']
        start_line = command['start_line']

        # Parse JSON code (sent as stringified JSON)
        adjusted_code = json.loads(code)

        # Try to exec as statement first
        is_expression = False
        try:
            # Check if it is an expression (has value)
            compiled = compile(adjusted_code, filename, 'eval')
            is_expression = True
        except SyntaxError:
            is_expression = False

        try:
            if is_expression:
                # Evaluate and print result
                result = eval(adjusted_code, persistent_globals)
                # Print representation to stdout if not None
                if result is not None:
                    print(repr(result), flush=True)
                    # Print type marker after result
                    print(TYPE_MARKER + type(result).__name__ + ">>>", flush=True)
            else:
                # Execute as statement
                compiled = compile(adjusted_code, filename, 'exec')
                exec(compiled, persistent_globals)

            # Signal successful execution
            print(SUCCESS_MARKER, flush=True)
        except Exception:
             # Print traceback to stderr
            traceback.print_exc(file=sys.stderr)
            # Signal error
            print(ERROR_MARKER, flush=True)

    except Exception:
        # Print traceback to stderr
        traceback.print_exc(file=sys.stderr)
        # Signal error
        print(ERROR_MARKER, flush=True)
`;

// Function to start the persistent REPL
    async function startRepl(pythonPath: string): Promise<boolean> {
        return new Promise((resolve) => {
            try {
                // --- NEW FIX: Patch environment variables to prevent DLL load crashes ---
                const pythonDir = path.dirname(pythonPath);
                const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: 'utf-8' };

                // Find the PATH key (it can be case-insensitive on Windows)
                const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
                const separator = process.platform === 'win32' ? ';' : ':';

                // Add common Conda/Venv binary directories to the PATH
                let binPaths = '';
                if (process.platform === 'win32') {
                    binPaths = `${pythonDir}${separator}${path.join(pythonDir, 'Scripts')}${separator}${path.join(pythonDir, 'Library', 'bin')}${separator}`;
                } else {
                    binPaths = `${pythonDir}${separator}${path.join(pythonDir, 'bin')}${separator}`;
                }
                env[pathKey] = binPaths + (env[pathKey] || '');

                // Fallback to current process directory if no workspace is open
                const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

                // Spawn with the patched environment and explicit cwd
                pythonRepl = spawn(pythonPath, ['-u', '-c', replWrapperCode], {
                    env: env,
                    cwd: cwd
                });

                replReady = false;
                currentPythonPath = pythonPath;

                let stdoutBuffer = '';
                let stderrBuffer = '';

                pythonRepl.stdout?.on('data', (data) => {
                    const text = data.toString();
                    stdoutBuffer += text;

                    // Check for ready marker
                    if (stdoutBuffer.includes('<<<PYLOT_READY>>>')) {
                        replReady = true;
                        stdoutBuffer = stdoutBuffer.replace(/<<<PYLOT_READY>>>\r?\n?/g, '');
                        if (!resolve) return;
                        const tempResolve = resolve;
                        resolve = null as any;
                        tempResolve(true);
                    }

                    // Check for success/error markers
                    if (stdoutBuffer.includes('<<<PYLOT_SUCCESS>>>')) {
                        // First extract type if present
                        let expressionType = '';
                        const typeMatchResult = stdoutBuffer.match(/<<<PYLOT_TYPE:([a-zA-Z_0-9]+)>>>/);
                        if (typeMatchResult) {
                            expressionType = typeMatchResult[1];
                        }

                        // Clean markers but preserve newlines from Python output
                        let cleanedBuffer = stdoutBuffer;
                        // Remove type marker and all following newlines
                        cleanedBuffer = cleanedBuffer.replace(/<<<PYLOT_TYPE:[^>]+>>>[\r\n]*/g, '');
                        // Remove success marker and all following newlines
                        cleanedBuffer = cleanedBuffer.replace(/<<<PYLOT_SUCCESS>>>[\r\n]*/g, '');

                        // For normal output (Shift+Enter): just remove markers
                        const normalOutput = cleanedBuffer;

                        // For popup (Ctrl+Alt+Space): replace newlines with spaces
                        const popupOutput = cleanedBuffer.replace(/[\r\n]+/g, ' ').trim();

                        // Store type for the popup
                        lastExpressionType = expressionType;

                        // Capture expression result for popup (only if popup command is active)
                        if (expressionResultCallback) {
                            expressionResultCallback(popupOutput);
                            expressionResultCallback = null;
                        } else if (normalOutput) {
                            // Only output to channel for normal execution (Shift+Enter)
                            outputChannel.append(normalOutput);
                        }

                        if (currentExecutionCallback) {
                            currentExecutionCallback(true);
                            currentExecutionCallback = null;
                        }
                        stdoutBuffer = '';
                    }
                    if (stdoutBuffer.includes('<<<PYLOT_ERROR>>>')) {
                        stdoutBuffer = stdoutBuffer.replace(/<<<PYLOT_ERROR>>>\r?\n?/g, '');

                        // Capture error output for popup (only if popup command is active)
                        const errorResult = stdoutBuffer.trim();
                        if (errorResult && expressionResultCallback) {
                            expressionResultCallback(errorResult);
                            expressionResultCallback = null;
                            // Don't output to channel for popup command
                        } else if (stdoutBuffer) {
                            // Only output to channel for normal execution (Shift+Enter)
                            outputChannel.append(stdoutBuffer);
                        }

                        if (currentExecutionCallback) {
                            currentExecutionCallback(false);
                            currentExecutionCallback = null;
                        }
                        stdoutBuffer = '';
                    }

                    // Output remaining buffer content
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

                // Timeout if REPL doesn't start
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

    // Function to stop the REPL
    function stopRepl() {
        if (pythonRepl) {
            pythonRepl.kill();
            pythonRepl = null;
            replReady = false;
        }
    }

    // Function to remove all color marks (decorations) from all Python editors
    function removeAllColorMarks() {
        const editors = vscode.window.visibleTextEditors;
        for (const editor of editors) {
            if (editor.document.languageId === 'python') {
                editor.setDecorations(runningDecoration, []);
                editor.setDecorations(executedDecoration, []);
                editor.setDecorations(errorDecoration, []);
            }
        }
    }

    // Function to execute code in the persistent REPL
    function executeInRepl(command: any, editor: vscode.TextEditor, trimmedRange: vscode.Range, canExecute: boolean): Promise<{ success: boolean; executed: boolean }> {
        return new Promise((resolve) => {
            if (!canExecute) {
                resolve({ success: false, executed: false });
                return;
            }

            // Set running decoration only when code is actually being executed
            editor.setDecorations(runningDecoration, [trimmedRange]);
            editor.setDecorations(executedDecoration, []);
            editor.setDecorations(errorDecoration, []);

            currentExecutionCallback = (execSuccess: boolean) => {
                resolve({ success: execSuccess, executed: true });
            };

            // Send command as JSON line
            pythonRepl?.stdin?.write(JSON.stringify(command) + '\n');
        });
    }

    // Register command to restart REPL
    let restartReplCommand = vscode.commands.registerCommand('pylot.restartRepl', async () => {
        // Remove all color marks when restarting REPL
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

    // Register the command to execute selected Python code
    let disposable = vscode.commands.registerCommand('pylot.executeSelectedPython', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return; }
        await executeSelectedPython(editor, true);
    });

    // Register the command to execute selected Python code without moving cursor
    let executeNoMoveCommand = vscode.commands.registerCommand('pylot.executeSelectedPythonNoMove', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return; }
        await executeSelectedPython(editor, false);
    });

    // Register command to clear output
    let clearOutputCommand = vscode.commands.registerCommand('pylot.clearOutput', () => {
        outputChannel.clear();
    });

    // Register command to remove all color marks
    let removeColorMarksCommand = vscode.commands.registerCommand('pylot.removeColorMarks', () => {
        removeAllColorMarks();
        vscode.window.showInformationMessage('All Pylot color marks removed.');
    });

async function executeSelectedPython(editor: vscode.TextEditor, moveCursor: boolean): Promise<void> {
        const selection = editor.selection;

        const pythonPath = await getPythonPath();
        if (!pythonPath) { return; }

        // 1. Pre-trim the selection to exclude leading/trailing empty lines and comments
        let initialStartLine = selection.start.line;
        let initialEndLine = selection.end.line;

        while (initialStartLine <= initialEndLine) {
            const text = editor.document.lineAt(initialStartLine).text.trim();
            if (text.length > 0 && !text.startsWith('#')) break;
            initialStartLine++;
        }

        while (initialEndLine >= initialStartLine) {
            const text = editor.document.lineAt(initialEndLine).text.trim();
            if (text.length > 0 && !text.startsWith('#')) break;
            initialEndLine--;
        }

        // --- NEW LOGIC FOR EMPTY/COMMENT SELECTIONS ---
        if (initialStartLine > initialEndLine) {
            if (moveCursor) {
                // Find the next valid line starting from the line AFTER the current selection's end
                let nextLine = selection.end.line + 1;
                while (nextLine < editor.document.lineCount) {
                    const lineText = editor.document.lineAt(nextLine).text;
                    if (lineText.trim().length > 0 && !lineText.trim().startsWith('#')) {
                        break;
                    }
                    nextLine++;
                }

                if (nextLine < editor.document.lineCount) {
                    const line = editor.document.lineAt(nextLine);
                    const newPos = new vscode.Position(nextLine, line.firstNonWhitespaceCharacterIndex);
                    editor.selection = new vscode.Selection(newPos, newPos);
                    editor.revealRange(new vscode.Range(newPos, newPos));
                } else {
                    // At end of file - check if cursor is already at an empty line after last executable content
                    const currentLineText = editor.document.lineAt(selection.start.line).text;
                    if (currentLineText.trim().length === 0) {
                        // Already at an empty line, stay there
                        return;
                    }
                    // Move to line after selection, inserting newline if needed
                    const targetLine = selection.end.line + 1;
                    if (targetLine >= editor.document.lineCount) {
                        // Insert a newline at the end of the document
                        const lastLine = editor.document.lineAt(editor.document.lineCount - 1);
                        const edit = new vscode.WorkspaceEdit();
                        edit.insert(editor.document.uri, lastLine.range.end, '\n');
                        await vscode.workspace.applyEdit(edit);
                    }
                    // Move the cursor to the new empty line
                    const newPos = new vscode.Position(targetLine, 0);
                    editor.selection = new vscode.Selection(newPos, newPos);
                    editor.revealRange(new vscode.Range(newPos, newPos));
                }
            }
            return; // Exit early: No execution, no markers changed
        }
        // --- END OF NEW LOGIC ---

        const preTrimmedSelection = new vscode.Selection(
            new vscode.Position(initialStartLine, 0),
            new vscode.Position(initialEndLine, editor.document.lineAt(initialEndLine).range.end.character)
        );

        // Start REPL if not running...
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

        let executionSelection = preTrimmedSelection;

        try {
            // 2. Fetch selection ranges for expansion

            // ADJUSTMENT 1: Shift query positions completely out of comments into code.
            let queryStart = preTrimmedSelection.start;
            let queryEnd = preTrimmedSelection.end;

            const startLine = editor.document.lineAt(queryStart.line);
            const startCommentIdx = startLine.text.indexOf('#');
            // If at or after a '#', move strictly to the code (first non-whitespace character)
            if (startCommentIdx !== -1 && queryStart.character >= startCommentIdx) {
                queryStart = new vscode.Position(queryStart.line, startLine.firstNonWhitespaceCharacterIndex);
            }

            const endLine = editor.document.lineAt(queryEnd.line);
            const endCommentIdx = endLine.text.indexOf('#');
            if (endCommentIdx !== -1 && queryEnd.character >= endCommentIdx) {
                queryEnd = new vscode.Position(queryEnd.line, endLine.firstNonWhitespaceCharacterIndex);
            }

            // FIX: Changed 'yield' to 'await'
            const ranges: any = await vscode.commands.executeCommand('vscode.executeSelectionRangeProvider', editor.document.uri, [queryStart, queryEnd]);

            // NEW LOGIC: Abort if the language server returns nothing during startup
            if (!ranges || ranges.length === 0) {
                vscode.window.showWarningMessage("Pylot: Language server is still initializing. Please wait a moment.");
                return;
            }

            if (ranges && ranges.length > 0) {
                // ADJUSTMENT 2: Calculate semantic document boundaries (ignoring trailing whitespace)
                let firstCodeLine = 0;
                while (firstCodeLine < editor.document.lineCount && editor.document.lineAt(firstCodeLine).text.trim() === '') {
                    firstCodeLine++;
                }
                let lastCodeLine = editor.document.lineCount - 1;
                while (lastCodeLine >= 0 && editor.document.lineAt(lastCodeLine).text.trim() === '') {
                    lastCodeLine--;
                }

                const getTopBlock = (selectionRange: any) => {
                    let current = selectionRange;
                    const chain = [];
                    while (current) {
                        chain.push(current);
                        current = current.parent;
                    }

                    // ROBUST CHECK: If the narrowest range (chain[0]) is ALREADY the whole document,
                    // the LS failed to find a localized AST node (e.g., stuck in whitespace/comment).
                    const narrowestRange = chain[0].range;
                    if (narrowestRange.start.line <= firstCodeLine && narrowestRange.end.line >= lastCodeLine) {
                        return null; // Return null to signal invalid expansion
                    }

                    // Walk down from the largest blocks
                    for (let i = chain.length - 1; i >= 0; i--) {
                        const r = chain[i].range;

                        const isWholeDoc = (r.start.line <= firstCodeLine && r.end.line >= lastCodeLine);
                        if (!isWholeDoc) {
                            return r;
                        }
                    }
                    return narrowestRange; // Fallback to the narrowest statement
                };

                const startBlockRange = getTopBlock(ranges[0]);
                const endBlockRange = ranges.length > 1 ? getTopBlock(ranges[1]) : startBlockRange;

                // Fall back to the original selection if the LS returned an unhelpful scope
                if (!startBlockRange || !endBlockRange) {
                    executionSelection = preTrimmedSelection;
                } else {
                    let finalStart = startBlockRange.start;
                    let finalEnd = endBlockRange.end;

                    if (preTrimmedSelection.start.isBefore(finalStart))
                        finalStart = preTrimmedSelection.start;
                    if (preTrimmedSelection.end.isAfter(finalEnd))
                        finalEnd = preTrimmedSelection.end;

                    // Safety check limit (still good to keep as a failsafe)
                    const originalLineCount = preTrimmedSelection.end.line - preTrimmedSelection.start.line + 1;
                    const expandedLineCount = finalEnd.line - finalStart.line + 1;
                    if (expandedLineCount > 100 && originalLineCount < 10) {
                        executionSelection = preTrimmedSelection;
                    } else {
                        executionSelection = new vscode.Selection(finalStart, finalEnd);
                    }
                }
            }
        } catch (e) {
            console.error("Error expanding selection:", e);
            // NEW LOGIC: Abort execution completely if the language server throws an error (e.g., not ready)
            vscode.window.showWarningMessage("Pylot: Language server is starting up. Please wait.");
            return;
        }

        let startLine = executionSelection.start.line;
        let endLine = executionSelection.end.line;
        let code = editor.document.getText(executionSelection);

        const command = {
            code: JSON.stringify(code),
            filename: editor.document.fileName,
            start_line: startLine + 1
        };

        // Tighten range for visual decorations
        while (startLine <= endLine) {
            const text = editor.document.lineAt(startLine).text.trim();
            if (text.length > 0 && !text.startsWith('#')) break;
            startLine++;
        }
        while (endLine >= startLine) {
            const text = editor.document.lineAt(endLine).text.trim();
            if (text.length > 0 && !text.startsWith('#')) break;
            endLine--;
        }

        const trimmedRange = new vscode.Range(
            new vscode.Position(startLine, 0),
            new vscode.Position(endLine, editor.document.lineAt(endLine).text.length)
        );

        const originalSelection = editor.selection;
        const canExecute = pythonRepl !== null && replReady && currentExecutionCallback === null;

        if (canExecute && moveCursor) {
            let nextLine = executionSelection.end.line + 1;
            while (nextLine < editor.document.lineCount) {
                const lineText = editor.document.lineAt(nextLine).text;
                if (lineText.trim().length > 0 && !lineText.trim().startsWith('#')) break;
                nextLine++;
            }

            if (nextLine < editor.document.lineCount) {
                const line = editor.document.lineAt(nextLine);
                const newPos = new vscode.Position(nextLine, line.firstNonWhitespaceCharacterIndex);
                editor.selection = new vscode.Selection(newPos, newPos);
                editor.revealRange(new vscode.Range(newPos, newPos));
            } else {
                // At end of file - check if cursor is already at an empty line after last executable content
                const currentLineText = editor.document.lineAt(selection.start.line).text;
                if (currentLineText.trim().length === 0) {
                    // Already at an empty line, stay there - don't move cursor
                } else {
                    // Move to line after the block, inserting newline if needed
                    const targetLine = executionSelection.end.line + 1;
                    if (targetLine >= editor.document.lineCount) {
                        // Insert a newline at the end of the document
                        const lastLine = editor.document.lineAt(editor.document.lineCount - 1);
                        const edit = new vscode.WorkspaceEdit();
                        edit.insert(editor.document.uri, lastLine.range.end, '\n');
                        await vscode.workspace.applyEdit(edit);
                    }
                    // Move the cursor to the new empty line
                    const newPos = new vscode.Position(targetLine, 0);
                    editor.selection = new vscode.Selection(newPos, newPos);
                    editor.revealRange(new vscode.Range(newPos, newPos));
                }
            }
        }

        const result = await executeInRepl(command, editor, trimmedRange, canExecute);

        if (result.executed) {
            editor.setDecorations(runningDecoration, []);
            if (result.success) {
                editor.setDecorations(executedDecoration, [trimmedRange]);
            } else {
                editor.setDecorations(errorDecoration, [trimmedRange]);
                editor.selection = originalSelection;
                editor.revealRange(originalSelection);
            }
        } else {
            editor.selection = originalSelection;
            editor.revealRange(originalSelection);
        }
    }

    // Helper function to validate if code is a valid Python expression
    async function isValidPythonExpression(code: string): Promise<boolean> {
        const pythonPath = await getPythonPath();
        if (!pythonPath) { return false; }

        return new Promise((resolve) => {
            try {
                // Use Python to check if code can be compiled as an expression
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
                let stderr = '';

                proc.stdout?.on('data', (data) => {
                    stdout += data.toString();
                });

                proc.stderr?.on('data', (data) => {
                    stderr += data.toString();
                });

                proc.on('close', (code) => {
                    resolve(stdout.trim() === 'VALID');
                });

                proc.on('error', () => {
                    resolve(false);
                });

                proc.stdin?.write(code);
                proc.stdin?.end();

                // Timeout after 2 seconds
                setTimeout(() => {
                    proc.kill();
                    resolve(false);
                }, 2000);

            } catch {
                resolve(false);
            }
        });
    }

    // Register command to evaluate expression and show in popup
    let evaluateExpressionCommand = vscode.commands.registerCommand('pylot.evaluateExpression', async () => {
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

        // Validate that the selected code is a valid Python expression before executing
        const isExpression = await isValidPythonExpression(code);
        if (!isExpression) {
            vscode.window.showInformationMessage('Selection is not a valid expression (statements cannot be evaluated)');
            return;
        }

        const pythonPath = await getPythonPath();
        if (!pythonPath) { return; }

        // Start REPL if not running or if Python path changed
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

        // Execute and wait for result
        const result = await new Promise<{ success: boolean; executed: boolean }>((resolve) => {
            if (!pythonRepl || !replReady) {
                resolve({ success: false, executed: false });
                return;
            }

            // Set up callback to capture the expression result
            expressionResultCallback = (resultText: string) => {
                lastExpressionResult = resultText;
            };

            currentExecutionCallback = (execSuccess: boolean) => {
                resolve({ success: execSuccess, executed: true });
            };

            pythonRepl.stdin?.write(JSON.stringify(command) + '\n');
        });

        if (result.success) {
            // Show result in custom webview popup
            const panel = vscode.window.createWebviewPanel(
                'pylotExpressionResult',
                'Expression Result',
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            const htmlContent = `
                <!DOCTYPE html>
                <html>
                <head>
                    <style>
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
                        h2 {
                            color: #569cd6;
                            border-bottom: 1px solid #3c3c3c;
                            padding-bottom: 10px;
                        }
                        .label {
                            font-weight: bold;
                            margin-bottom: 5px;
                            margin-top: 15px;
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
                            color: #4ec9b0;
                            font-size: 16px;
                            max-height: 200px;
                            overflow-y: auto;
                        }
                        .type-box {
                            color: #9cdcfe;
                        }
                        .no-output {
                            color: #808080;
                            font-style: italic;
                        }
                        .error {
                            color: #f44747;
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
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h2>Expression Result</h2>
                        <div class="label">Expression:</div>
                        <div class="expression-box">
                            ${code.replace(/</g, '&lt;').replace(/>/g, '&gt;')}
                        </div>
                        ${lastExpressionType ? `<div class="label type-box">Type: ${lastExpressionType}</div>` : ''}
                        ${lastExpressionResult && lastExpressionResult.trim() ?
                            `<div class="label">Result:</div>
                            <div class="result-box">
                                ${lastExpressionResult.replace(/</g, '&lt;').replace(/>/g, '&gt;')}
                            </div>` :
                            `<div class="label">Result:</div>
                            <div class="result-box no-output">
                                Expression evaluated successfully (no output)
                            </div>`
                        }
                        <button onclick="vscode.postMessage({ command: 'close' })">Close</button>
                    </div>
                    <script>
                        const vscode = acquireVsCodeApi();
                        document.querySelector('button').addEventListener('click', () => {
                            vscode.postMessage({ command: 'close' });
                        });
                    </script>
                </body>
                </html>
            `;

            panel.webview.html = htmlContent;

            // Handle close message from webview
            panel.webview.onDidReceiveMessage((message) => {
                if (message.command === 'close') {
                    panel.dispose();
                }
            });
        } else {
            // Show error in custom webview popup
            const panel = vscode.window.createWebviewPanel(
                'pylotExpressionError',
                'Expression Error',
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            const htmlContent = `
                <!DOCTYPE html>
                <html>
                <head>
                    <style>
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
                        h2 {
                            color: #f44747;
                            border-bottom: 1px solid #3c3c3c;
                            padding-bottom: 10px;
                        }
                        .expression {
                            background-color: #2d2d2d;
                            padding: 10px;
                            border-radius: 4px;
                            margin-bottom: 20px;
                            overflow-x: auto;
                        }
                        .error {
                            background-color: #2d2d2d;
                            padding: 15px;
                            border-radius: 4px;
                            color: #f44747;
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
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h2>Expression Evaluation Failed</h2>
                        <div class="expression">
                            <strong>Expression:</strong><br>
                            ${code.replace(/</g, '&lt;').replace(/>/g, '&gt;')}
                        </div>
                        <div class="error">
                            Check the "pylot" output channel for details.
                        </div>
                        <button onclick="vscode.postMessage({ command: 'close' })">Close</button>
                    </div>
                    <script>
                        const vscode = acquireVsCodeApi();
                        document.querySelector('button').addEventListener('click', () => {
                            vscode.postMessage({ command: 'close' });
                        });
                    </script>
                </body>
                </html>
            `;

            panel.webview.html = htmlContent;

            // Handle close message from webview
            panel.webview.onDidReceiveMessage((message) => {
                if (message.command === 'close') {
                    panel.dispose();
                }
            });
        }
    });

    context.subscriptions.push(disposable);
    context.subscriptions.push(executeNoMoveCommand);
    context.subscriptions.push(restartReplCommand);
    context.subscriptions.push(clearOutputCommand);
    context.subscriptions.push(removeColorMarksCommand);
    context.subscriptions.push(evaluateExpressionCommand);
}

export function deactivate() {
    // Clean up the REPL process on deactivation
    if (pythonRepl) {
        pythonRepl.kill();
    }
}
