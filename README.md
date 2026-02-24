# Pylot - Python line runner

A VSCode extension that runs lines of Python code with visualized smart selection.

## Features

- **Execute Selected Python** - Run selected code in a persistent Python REPL
- **Visual Line Markers** - See execution status with gutter icons:
  - 🟠 Orange: Currently running
  - 🟢 Green: Successfully executed
  - 🔴 Red: Error occurred
- **Clean Output Window** - Output is displayed in a dedicated panel, without repeating the code lines.
- **Persistent REPL** - Maintains state between executions
- **Restart REPL** - Clear and restart the Python REPL session
- **Clear Output** - Clear the output channel
- **Evaluate Expression** - Quick evaluation of selected Python expressions

<br>

<div align="left">
<img src="pylot.gif" alt="Pylot Demo" width="763" />
</div>

## Requirements

- [Python extension](https://marketplace.visualstudio.com/items?itemName=ms-python.python) (ms-python.python) - Required for Python interpreter detection

## Usage

### Execute Selected Code

1. Select Python code in your editor
2. Press `Shift+Enter` to execute
3. Results appear in the "pylot" output channel

### Commands

| Command | Action | Default Shortcut |
|---------|--------|------------------|
| Execute Selected Python | Run selected code | `Shift+Enter` |
| Execute Selected Python (No Cursor Move) | Run selected code without moving cursor | `Shift+Ctrl+Enter` |
| Restart Python REPL | Restart the REPL session | - |
| Clear Python Output | Clear the output channel | `Ctrl+Shift+C` |
| Remove All Color Marks | Remove all gutter markers | - |
| Evaluate Python Expression | Quick evaluate expression | `Ctrl+Alt+Space` |

### Keyboard Shortcuts

- `Shift+Enter` - Execute selected Python code
- `Shift+Ctrl+Enter` - Execute selected Python code without moving cursor
- `Ctrl+Shift+C` - Clear output (when Python file is focused)
- `Ctrl+Alt+Space` - Evaluate selected expression

## Extension Settings

This extension has no configurable settings. It uses the Python interpreter selected in the Python extension.

## Installation

1. Open VS Code
2. Go to Extensions (`Ctrl+Shift+X`)
3. Search for "Pylot"
4. Click Install

## License

MIT

## Author

[bitagoras](https://github.com/bitagoras)
