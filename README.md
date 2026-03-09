# Pylot – Python code runner
A VS Code extension that runs Python code directly from the editor using smart selection and visual line markers. It turns your editor into an interactive Python environment and lets you write, run and evaluate Python code at the same time and in one place. Use it as a lightweight and flexible alternative to data science notebooks.

## Features

- **Execute Python code** – Run selected code or the current line with `Shift+Enter`.
- **Smart selection** – Selection will be expanded to execute only full valid Python statements or blocks.
- **Visual line markers** – Line markers show the selection and execution state:
  - 🟧 Orange (animated): currently running
  - 🟩 Green: successfully executed
  - 🟥 Red: error occurred
- **Execute whole program** – Run the entire file with `Shift+Ctrl+Alt+Enter`
- **Pure output window** – Output is displayed in a dedicated panel, without repeating the code.
- **Variable inspection** – Hover over any variable to see its type and current value in a tooltip, even while the code is running. It also shows the length of sized objects and the shape of NumPy arrays.
- **Expression evaluation** – Pressing `Ctrl+Shift+Space` evaluates any selected expression or variable at the cursor and shows the result in a tooltip.
- **Cell execution** – `Shift+Enter` at a cell comment, which starts with `#%%`, executes the entire cell until the next cell comment or the end of the file.
- **Execution interruption** – Easily interrupt long-running or stuck code using `Ctrl+Alt+C` without losing your Python state.
- **Matplotlib support** – Keeps multiple Matplotlib plot windows open and interactive while you continue working.

<br>

<div align="left">
<img src="pylot.gif" alt="Pylot Demo" width="763" />
</div>

### Commands

| Command | Action | Default Shortcut |
|---------|--------|------------------|
| Execute Selected Python | Run selected code and advance cursor | `Shift+Enter` |
| Execute Selected Python (No Cursor Move) | Run selected code, keep cursor in place | `Shift+Ctrl+Enter` |
| Execute Whole Python Program | Run the entire file | `Shift+Ctrl+Alt+Enter` |
| Restart Python | Restart the Python session | – |
| Clear Python Output | Clear the output channel | `Ctrl+Shift+C` |
| Hide Active Line Markers | Hide currently active line markers | – |
| Evaluate Python Expression | Evaluate expression or variable and show tooltip | `Ctrl+Shift+Space` |
| Interrupt Execution | Interrupt running code (sends KeyboardInterrupt) | `Ctrl+Alt+C` |

## Configuration

Pylot provides the following settings to customize its behavior:

- `pylot.replWorkingDirectory`: Ordered list of candidate working directories for the Python session. Each entry is tried from left to right; the first one that resolves to an existing directory is used. Supports VS Code variables: `${fileDirname}` (directory of the active file), `${workspaceFolder}`, `${userHome}`, and absolute paths. Default: `["${fileDirname}", "${workspaceFolder}", "${userHome}"]`.
- `pylot.matplotlibEventHandler`: Controls when the Matplotlib non-blocking event handler is injected into the Python session (default: `auto`).
- `pylot.executionMarkerStyle`: Configures the visual style of execution state markers. Options are `gutter`, `border` or `off` (default: `gutter`).

## Installation

1. Open **Extensions** in VS Code (`Ctrl+Shift+X`).
2. Search for **Pylot** and click **Install**.
3. The required Python extension (`ms-python.python`) will be installed automatically.
4. If other Python extensions have claimed `Shift+Enter`, `Ctrl+Shift+Enter` or `Shift+Ctrl+Alt+Enter`, you may need to remove those bindings:
   - Open the command palette (`Ctrl+Shift+P`) → **Preferences: Open Keyboard Shortcuts**.
   - Search for the conflicting shortcut and remove or reassign it.

## Requirements

- [Python extension](https://marketplace.visualstudio.com/items?itemName=ms-python.python) (`ms-python.python`) – installed automatically as a dependency.

## License

MIT

## Author

[bitagoras](https://github.com/bitagoras)
