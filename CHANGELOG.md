# Changelog

All notable changes to the **Pylot** extension will be documented in this file.

## [1.5.1] - 2026-03-29

### Bug Fixes
- **Variable hints no longer leak across scopes**: Fixed an issue where inlay hints for `for`-loop variables inside a function body would incorrectly display the value of a same-named variable from the outer (global) scope after the function definition was re-executed. Hints for loop variables inside functions are now cleared when the function definition is run.
- **Shift+Enter no longer triggers Python REPL when Pylot is active**: Removed `!suggestWidgetVisible` from the keybinding condition so Pylot's binding wins over the Python extension's "Run Selection/Line in Python Terminal" command even when an autocompletion popup is visible.

### Improvements
- **Different stability and efficiency updates**: Reuse of Python parse tree, improved key bindung precedence during startup, clear MCP function feedback status. Progressbar style changed from `[■■□□□]` to `[■■---]`.

## [1.5.0] - 2026-03-28

### New Features
- **Live Variable Overlay (Inlay Hints)**: Variable values now appear as subtle "ghost text" to the right of executed Python lines. This provides instant feedback without needing to hover or switch to the output panel.
- **Live For-Loop Progress Bars**: Automatically shows progress bars for long-running `for` loops directly in the editor.
- **Expression Result Previews**: Executing single expressions (e.g., `1 + 1` or a string) now displays the evaluation result directly in the editor as an inlay hint.
- **Toggle & Clear Commands**: Added `Pylot: Toggle Inlay Hints` and `Pylot: Clear Inlay Hints` to the command palette for easy UI management.
- **Adjustable Styling**: Added `pylot.inlayHintColor` setting to customize the appearance of the Live Variable Overlay.
- `pylot.maxInlayHintLength`: Maximum characters for an inlay hint before it is truncated (default: `50`).
- `pylot.inlayHintColor`: Custom color for the variable overlay in hex format (default: `#ffdf0088`).
- **Improved Default Color**: Switched to a slightly warmer yellow-gold (`#ffdf0088`) for better visibility.
- **Quote Formatting**: String variables in inlay hints are now automatically enclosed in quotes for better readability.

## [1.4.1] - 2026-03-27

### Improvements
- **Simplified Command Palette**: Hidden "Pylot Agent" commands from the command palette to reduce UI clutter. These commands are now exclusively intended for AI agents (e.g. via MCP).

## [1.4.0] - 2026-03-25

### New Features
- **Native MCP SSE Server**: Replaced the external Node.js bridge with a high-performance, built-in MCP (Model Context Protocol) server using the SSE (Server-Sent Events) transport. This "battery-included" solution eliminates the need for an external `node` dependency and provides a seamless setup for AI agents like **Continue** and **Kilocode**.
- **Multi-Client Support**: The server now handles multiple concurrent AI agents through unique session IDs.
- **Granular Debug Settings**: Split `pylot.debugMode` into `pylot.debug.python` and `pylot.debug.mcpServer` for more precise diagnostic control.
- **Automatic Activation**: The internal MCP server now activates automatically on extension startup when enabled.

### Improvements
- **Protocol Compliance**: Strict JSON-RPC 2.0 handling and proper SSE framing for maximum agent compatibility.
- **Project Structure**: Excluded legacy MCP bridge scripts from the VSIX package to reduce extension size.
- **Cell Syntax Change**: Changed the cell comment from `#%%` to `#%` to allow cells that are not recognized by other Python extensions.

## [1.3.1] - 2026-03-23

### New Features
- **Enhanced AI Agency**: Expanded the MCP server with four new tools for better interactive control:
  - `pylot_read_file`: Reads the active editor's content (with optional line numbers).
  - `pylot_edit_code`: Performs surgical, precise search-and-replace edits.
  - `pylot_restart_repl`: Resets the Python REPL state and clears its memory.
  - `pylot_interrupt_execution`: Manually stops running code (KeyboardInterrupt).

## [1.3.0] - 2026-03-22

### New Features
- **MCP Server Bridge**: Added a built-in Model Context Protocol (MCP) server that lets AI coding assistants (Kilocode, Continue, etc.) interact with the Pylot REPL directly. Enable it with the new `pylot.mcpServer.enabled` setting. The bundled script `mcp/pylot-mcp-server.js` exposes five AI-callable tools: `pylot_append_and_execute`, `pylot_execute_range`, `pylot_get_status`, `pylot_evaluate_expression`, and `pylot_get_output`.
- **`pylot.mcpServer.enabled`**: New setting to start a localhost HTTP IPC server that the MCP script connects to. Disabled by default.
- **`pylot.mcpServer.port`**: New setting to configure the IPC server port (default: `7822`). Change it if the port is already in use.

### Improvements
- **Running Marker Style**: Refined the orange running gutter marker with a flowing dashed line and a synchronized breathing opacity effect.

### Improvements
- **Error Marker Style**: Updated the red error gutter marker to feature a continuous, subtle sine wave instead of a straight line.

## [1.2.5] - 2026-03-10

### Bug Fixes
- **Start REPL Function**: Fixed a bug related to the renamed `startRepl` function.

### Improvements
- **Keybinding Precedence**: Improved the precedence of Pylot's keybindings (like `Shift+Enter`) so they reliably outperform the Python extension's defaults when editing Python files.

## [1.2.4] - 2026-03-09
### Bug Fixes
- **Color Marker Persistence**: Color execution markers now persist per-document across editor tabs.

## [1.2.0] - 2026-03-08

### New Features
- **Debug Mode**: Added `pylot.debugMode` setting to enable detailed execution diagnostics in the output panel.
- **Working Directory Fallback List**: `pylot.replWorkingDirectory` is now an ordered list of candidate directories. Each entry is tried in sequence; the first that resolves to an existing path is used. Supports `${fileDirname}`, `${workspaceFolder}`, `${userHome}`, and absolute paths. Entries requiring a file path (e.g. `${fileDirname}`) are automatically skipped for unnamed files, so the REPL retains the working directory of the last executed named file.

### Bug Fixes
- **First Line Block**: Fixed an issue where the first line of a code block was not correctly identified.
- **Untitled Files**: Improved support for executing code in unsaved or unnamed files.

## [1.1.0] - 2026-03-04

### New Features
- **Configurable REPL Working Directory**: Added `pylot.replWorkingDirectory` setting to control the REPL's current working directory. Defaults to the active file's directory (`${fileDirname}`).
- **Execute Whole Program**: Added a new shortcut (`Shift+Ctrl+Alt+Enter`) and command (`Pylot: Execute Whole Python Program`) to execute the entire Python file.

## [1.0.1] - 2026-03-02

### Bug Fixes
- **Execution Command Guard**: The execution command now has no effect for selected lines while code is already running. This prevents accidental multiple execution requests while the REPL is currently processing.
- **Removed Duplicate Function**: Cleaned up the codebase by removing a redundant function.

### Improvements
- **Smaller File Size**: Significant reduction in extension package size due to a shorter and optimized `pylot.gif` preview.

## [1.0.0] - 2026-03-01

### New Features
- **Interrupt Running Code**: Manually halt long-running tasks using `Ctrl+Alt+C` or the command palette.
- **Customizable Line Markers**: Choose between gutter icons, left-border lines, or turn markers off via `pylot.executionMarkerStyle`.
- **Hide Active Line Markers**: Quickly clear execution indicators with the new `Pylot: Hide Active Line Markers` command.
- **Cell Block Execution**: Define cells with the `# %%` comment syntax for targeted execution.
- **Live Variable Inspection**: Evaluate expressions and inspect variables interactively while code is running.
- **Native Input Support**: Seamlessly handle Python's `input()` function via VS Code input boxes.

### Bug Fixes
- **Solidified REPL Communication**: Overhauled communication protocol for significantly better robustness and synchronization.

## [0.6.0] - 2026-03-01 (Pre-release)

### New Features
- **Variable Inspection on Hover**: See type and value in native tooltips.
- **Detailed Type Information**: Tooltips include length (for lists/strings) and shape (for NumPy arrays/tensors).
- **On-Demand Expression Evaluation**: Evaluate selected expressions using `Ctrl+Shift+Space`.
- **Safe Evaluation**: Explicit triggers for function calls in tooltips to prevent side effects.

## [0.5.0] - 2026-02-28 (Initial Pre-release)

### Core Features
- **Smart Selection Execution**: Intelligent block detection.
- **Persistent Background REPL**: Maintains state across executions.
- **Visual Gutter Markers**: Color-coded states for Running (orange), Success (green), and Error (red).
- **Matplotlib Support**: Interactive, non-blocking figures with `pylot.matplotlibEventHandler`.
- **Output Management**: Dedicated clean output channel.
