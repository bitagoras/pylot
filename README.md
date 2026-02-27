# Pylot – Python code runner

A VS Code extension that runs Python code directly from the editor with smart selection and visual line markers. Commands are entered in the editor itself — not copied to a terminal — so the editor acts as the input interface while results appear in a dedicated output panel. This lets you build up an interactive session that can be saved, reproduced, or finalized as a Python script.

## Features

- **Execute Python code** – Run selected code (or the current block) in a persistent Python REPL with `Shift+Enter`.
- **Clean output window** – Output is displayed in a dedicated panel, without repeating the code lines.
- **Visual line markers** – Gutter icons show smart selection and execution state:
  - 🟧 Orange (animated): currently running
  - 🟩 Green: successfully executed
  - 🟥 Red: error occurred
- **Evaluate expression** – Quickly evaluate a selected expression and see the result in a popup (`Ctrl+Alt+Space`).
- **Matplotlib support** – Keeps Matplotlib plot windows open and interactive while you continue working.

<br>

<div align="left">
<img src="pylot.gif" alt="Pylot Demo" width="763" />
</div>

## Requirements

- [Python extension](https://marketplace.visualstudio.com/items?itemName=ms-python.python) (`ms-python.python`) – installed automatically as a dependency.

## Usage

### Execute Selected Code

1. Place your cursor on a line or select a block of Python code.
2. Press `Shift+Enter` to execute.
3. Results appear in the **pylot** output channel.

The extension uses the language server's smart selection to automatically expand your cursor to the enclosing top-level statement or block (function, class, etc.), so you rarely need to manually select code.

### Commands

| Command | Action | Default Shortcut |
|---------|--------|------------------|
| Execute Selected Python | Run selected code and advance cursor | `Shift+Enter` |
| Execute Selected Python (No Cursor Move) | Run selected code, keep cursor in place | `Shift+Ctrl+Enter` |
| Restart Python REPL | Restart the REPL session | – |
| Clear Python Output | Clear the output channel | `Ctrl+Shift+C` |
| Remove All Color Marks | Remove all gutter markers | – |
| Evaluate Python Expression | Evaluate expression and show popup | `Ctrl+Alt+Space` |

## Extension Settings

* `pylot.matplotlibEventHandler` – Controls when the Matplotlib non-blocking event handler is injected into the REPL.
  * `auto` (default) – Detects the `matplotlib` keyword in the code and loads the event handler before execution.
  * `always` – Loads the event handler on REPL startup.
  * `never` – Disables the custom event handler entirely.

## Installation

1. Open **Extensions** in VS Code (`Ctrl+Shift+X`).
2. Search for **Pylot** and click **Install**.
3. The required Python extension (`ms-python.python`) will be installed automatically.
4. If other Python extensions have claimed `Shift+Enter` or `Ctrl+Shift+Enter`, you may need to remove those bindings:
   - Open the command palette (`Ctrl+Shift+P`) → **Preferences: Open Keyboard Shortcuts**.
   - Search for the conflicting shortcut and remove or reassign it.

## License

MIT

## Author

[bitagoras](https://github.com/bitagoras)
