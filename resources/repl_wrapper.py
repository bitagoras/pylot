import sys, json, traceback, os, re, ast, time, io, tokenize
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
        real_stdout.write(f"<<<PYLOT_JSON>>>{json.dumps(kwargs)}\n")
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
            s_val = s_val.replace('\n', ' ')
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

def extract_watch_marker_lines(code):
    marker_lines = set()
    try:
        reader = io.StringIO(code).readline
        for tok in tokenize.generate_tokens(reader):
            if tok.type == tokenize.COMMENT and tok.string.lstrip().startswith('#?'):
                marker_lines.add(tok.start[0])
    except Exception:
        pass
    return marker_lines

def collect_store_name_leaves(target):
    names = []
    if isinstance(target, ast.Name) and isinstance(target.ctx, ast.Store):
        names.append(target.id)
    elif isinstance(target, (ast.Tuple, ast.List)):
        for elt in target.elts:
            names.extend(collect_store_name_leaves(elt))
    elif isinstance(target, ast.Starred):
        names.extend(collect_store_name_leaves(target.value))
    return names

def dedupe_preserve_order(items):
    seen = set()
    out = []
    for item in items:
        if item in seen:
            continue
        seen.add(item)
        out.append(item)
    return out

def build_watch_specs(tree, marker_lines):
    specs = {}
    if not marker_lines:
        return specs

    for node in ast.walk(tree):
        if not isinstance(node, ast.stmt):
            continue

        line_no = getattr(node, 'lineno', None)
        if line_no is None or line_no not in marker_lines:
            continue

        if isinstance(node, ast.Expr):
            specs[line_no] = {
                'mode': 'expr',
            }
            continue

        if isinstance(node, ast.Assign):
            names = []
            for target in node.targets:
                names.extend(collect_store_name_leaves(target))
            names = dedupe_preserve_order(names)
            if names:
                specs[line_no] = {
                    'mode': 'names',
                    'names': names,
                }
            continue

        if isinstance(node, ast.AnnAssign):
            names = dedupe_preserve_order(collect_store_name_leaves(node.target))
            if names:
                specs[line_no] = {
                    'mode': 'names',
                    'names': names,
                }
            continue

        if isinstance(node, ast.AugAssign):
            names = dedupe_preserve_order(collect_store_name_leaves(node.target))
            if names:
                specs[line_no] = {
                    'mode': 'names',
                    'names': names,
                }

    return specs

def make_watch_names_stmt(stmt, filename, line_no, names):
    call = ast.Call(
        func=ast.Name(id='_pylot_watch_names', ctx=ast.Load()),
        args=[
            make_ast_constant(line_no - 1),
            make_ast_constant(filename),
            ast.List(elts=[make_ast_constant(name) for name in names], ctx=ast.Load()),
            ast.Call(func=ast.Name(id='locals', ctx=ast.Load()), args=[], keywords=[]),
        ],
        keywords=[]
    )
    watch_stmt = ast.Expr(value=call)
    ast.copy_location(watch_stmt, stmt)
    return watch_stmt

def make_watch_expr_stmt(stmt, filename, line_no):
    lambda_node = ast.Lambda(
        args=ast.arguments(
            posonlyargs=[],
            args=[],
            vararg=None,
            kwonlyargs=[],
            kw_defaults=[],
            kwarg=None,
            defaults=[],
        ),
        body=stmt.value,
    )

    call = ast.Call(
        func=ast.Name(id='_pylot_watch_expr', ctx=ast.Load()),
        args=[
            lambda_node,
            make_ast_constant(line_no - 1),
            make_ast_constant(filename),
        ],
        keywords=[]
    )
    watch_stmt = ast.Expr(value=call)
    ast.copy_location(watch_stmt, stmt)
    return watch_stmt

def instrument_watch_stmt_list(stmts, filename, watch_specs):
    new_stmts = []
    for stmt in stmts:
        instrument_watch_node_blocks(stmt, filename, watch_specs)

        line_no = getattr(stmt, 'lineno', None)
        spec = watch_specs.get(line_no) if line_no is not None else None

        if spec and spec.get('mode') == 'expr' and isinstance(stmt, ast.Expr):
            stmt = make_watch_expr_stmt(stmt, filename, line_no)

        new_stmts.append(stmt)

        if spec and spec.get('mode') == 'names' and isinstance(stmt, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            names = spec.get('names', [])
            if names:
                new_stmts.append(make_watch_names_stmt(stmt, filename, line_no, names))

    return new_stmts

def instrument_watch_node_blocks(node, filename, watch_specs):
    for field in ('body', 'orelse', 'finalbody'):
        block = getattr(node, field, None)
        if isinstance(block, list):
            setattr(node, field, instrument_watch_stmt_list(block, filename, watch_specs))

    handlers = getattr(node, 'handlers', None)
    if isinstance(handlers, list):
        for handler in handlers:
            if hasattr(handler, 'body') and isinstance(handler.body, list):
                handler.body = instrument_watch_stmt_list(handler.body, filename, watch_specs)

    cases = getattr(node, 'cases', None)
    if isinstance(cases, list):
        for case in cases:
            if hasattr(case, 'body') and isinstance(case.body, list):
                case.body = instrument_watch_stmt_list(case.body, filename, watch_specs)

def instrument_watch_tree(tree, filename, watch_specs):
    tree.body = instrument_watch_stmt_list(tree.body, filename, watch_specs)
    return tree

watch_last_update = {}

def stringify_watch_value(value, max_len=100):
    s_val = repr(value) if isinstance(value, str) else str(value)
    s_val = s_val.replace('\n', ' ')
    if len(s_val) > max_len:
        s_val = s_val[:max_len - 3] + '...'
    return s_val

def should_emit_watch(filename, line_number):
    now = time.time()
    key = (filename, line_number)
    last = watch_last_update.get(key)
    if last is not None and (now - last) < 0.5:
        return False
    watch_last_update[key] = now
    return True

def _pylot_watch_names(line_number, filename, names, local_vars):
    if not should_emit_watch(filename, line_number):
        return

    parts = []
    for name in names:
        if isinstance(local_vars, dict) and name in local_vars:
            value = local_vars[name]
        elif name in persistent_globals:
            value = persistent_globals[name]
        else:
            continue
        parts.append(f"{name}={stringify_watch_value(value)}")

    if parts:
        send_msg('hints', line=line_number, text=', '.join(parts), filename=filename)

def _pylot_watch_expr(expr_callable, line_number, filename):
    value = expr_callable()
    if should_emit_watch(filename, line_number):
        send_msg('hints', line=line_number, text=stringify_watch_value(value), filename=filename)
    return value

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
                s_item = s_item.replace('\n', ' ')
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
            s_item = s_item.replace('\n', ' ')
            if len(s_item) > 80: s_item = s_item[:77] + "..."
            final_str = f"{var_name}={s_item}"
            send_msg('hints', line=line_number, text=final_str, filename=filename)

persistent_globals = {
    '__name__': '__main__',
    '__doc__': None,
    '_pylot_progress': _pylot_progress,
    '_pylot_watch_names': _pylot_watch_names,
    '_pylot_watch_expr': _pylot_watch_expr,
}
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
                        req_id = command.get('requestId')
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

                            kwargs = dict(success=True, result=str(result), datatype=datatype, shape=shape, len=length)
                            if req_id is not None:
                                kwargs['requestId'] = req_id
                            send_msg('evaluate_async', **kwargs)
                        except Exception:
                            kwargs = dict(success=False)
                            if req_id is not None:
                                kwargs['requestId'] = req_id
                            send_msg('evaluate_async', **kwargs)
                        continue
                    elif action == 'set_item_async':
                        req_id = command.get('requestId')
                        try:
                            expr = command.get('expr', '')
                            indices = command.get('indices', [])
                            raw_value = command.get('value', 0)
                            obj = eval(expr, persistent_globals)
                            # Try to cast value to the array's dtype
                            try:
                                raw_value = type(obj.flat[0])(raw_value)
                            except Exception:
                                pass
                            obj[tuple(int(i) for i in indices)] = raw_value
                            kwargs = dict(success=True)
                            if req_id is not None:
                                kwargs['requestId'] = req_id
                            send_msg('set_item_async', **kwargs)
                        except Exception as e:
                            kwargs = dict(success=False, error=str(e))
                            if req_id is not None:
                                kwargs['requestId'] = req_id
                            send_msg('set_item_async', **kwargs)
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
            line = input_queue.get(timeout=0.05)
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
        use_watch = command.get('watch', True)

        if mpl_mode == 'auto' and 'matplotlib' in adjusted_code:
            force_patch_matplotlib()

        if start_line > 1:
            adjusted_code = ("\n" * (start_line - 1)) + adjusted_code

        is_expression = False
        watch_marker_lines = extract_watch_marker_lines(adjusted_code) if use_watch else set()
        try:
            compiled = compile(adjusted_code, filename, 'eval')
            is_expression = True
        except SyntaxError:
            is_expression = False

        if watch_marker_lines:
            is_expression = False

        try:
            old_ids = {k: id(v) for k, v in persistent_globals.items()}
            fallback_line = adjusted_code.rstrip().count('\n') + 1
            line_keys = {}
            watch_specs = {}
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
                    res_str = res_str.replace('\n', ' ')
                    if len(res_str) > 100: res_str = res_str[:97] + "..."
                    expr_last_line_idx = adjusted_code.rstrip().count('\n')
                    send_msg('hints', line=expr_last_line_idx, text=res_str, filename=filename)
                else:
                    send_msg('execute', success=True)
            else:
                try:
                    tree = ast.parse(adjusted_code)
                    clear_function_for_loop_hints(tree, filename)
                    _, line_keys = get_changed_keys_and_lines(tree, fallback_line)
                    if use_watch and watch_marker_lines:
                        watch_specs = build_watch_specs(tree, watch_marker_lines)
                        if watch_specs:
                            tree = instrument_watch_tree(tree, filename, watch_specs)
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
                if l in watch_specs:
                    continue
                summary = get_locals_summary(keys)
                if summary:
                    send_msg('hints', line=l-1, text=summary, filename=filename)
        except KeyboardInterrupt:
            print("\nKeyboardInterrupt", file=sys.stderr)
            send_msg('execute', success=False)
        except Exception as e:
            print_exception_with_links(e)
            send_msg('execute', success=False)

    except KeyboardInterrupt:
        print("\nKeyboardInterrupt", file=sys.stderr)
        send_msg('execute', success=False)
    except Exception as e:
        print_exception_with_links(e)
        send_msg('execute', success=False)

