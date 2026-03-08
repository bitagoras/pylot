# Changelog

All notable changes to the **Pylot** extension will be documented in this file.

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
