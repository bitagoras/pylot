import sys, json, traceback, os, re, ast, time, io, tokenize
import threading
import queue
import builtins

if '.' not in sys.path:
    sys.path.insert(0, '.')

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
}
input_queue = queue.Queue()
input_reply_queue = queue.Queue()

MAX_INSPECT_REPR_LEN = 120

def _json_safe_value(value):
    try:
        import numpy as np
        if isinstance(value, np.ndarray):
            if value.dtype.kind == 'M':  # datetime64 — not JSON-serialisable via tolist(); use raw int64
                return _json_safe_value(value.view(np.int64).tolist())
            if value.dtype.kind == 'm':  # timedelta64 — same issue
                return _json_safe_value(value.view(np.int64).tolist())
            return _json_safe_value(value.tolist())
        if isinstance(value, np.generic):
            if isinstance(value, np.datetime64):
                return int(value.view(np.int64))
            if isinstance(value, np.timedelta64):
                return int(value.view(np.int64))
            return _json_safe_value(value.item())
    except Exception:
        pass

    import datetime as _dt
    if isinstance(value, (_dt.datetime, _dt.date, _dt.time, _dt.timedelta)):
        # Fallback for numpy .item() returning Python datetime objects (numpy >= 2.0)
        return str(value)

    if isinstance(value, list):
        return [_json_safe_value(item) for item in value]
    if isinstance(value, tuple):
        return [_json_safe_value(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _json_safe_value(item) for key, item in value.items()}
    if isinstance(value, bytes):
        try:
            return value.decode('utf-8')
        except Exception:
            return repr(value)
    if isinstance(value, bytearray):
        return _json_safe_value(bytes(value))
    if isinstance(value, float):
        if value != value:
            return 'NaN'
        if value == float('inf'):
            return 'Infinity'
        if value == float('-inf'):
            return '-Infinity'
    if isinstance(value, complex):
        return repr(value)
    return value

def _pylot_dump_json_safe(value):
    return json.dumps(_json_safe_value(value), ensure_ascii=False)

def _type_name(value):
    """Return a display-friendly type name for a value."""
    if isinstance(value, type):
        return 'class'
    return type(value).__name__

def _short_repr(value, max_len=MAX_INSPECT_REPR_LEN):
    try:
        if isinstance(value, (bool, int, float, complex, str)):
            text = repr(value)
        elif callable(value) or type(value).__name__ in ('method_wrapper', 'builtin_function_or_method', 'method', 'function'):
            doc = getattr(value, '__doc__', None)
            if doc and isinstance(doc, str) and doc.strip():
                text = doc.strip().split('\n')[0]
            else:
                text = ""
            if isinstance(value, type) and not text:
                text = f"class {getattr(value, '__module__', '')}.{getattr(value, '__name__', '')}"
        elif hasattr(value, '__name__') and hasattr(value, '__module__'):
            text = f"<{type(value).__name__} {value.__module__}.{value.__name__}>"
        else:
            text = repr(value)
            if text.startswith('<') and ' at 0x' in text:
                text = re.sub(r' at 0x[0-9A-Fa-f]+', '', text)
    except Exception:
        text = f"<{type(value).__name__}>"

    if not text:
        return ""

    text = text.replace('\n', ' ')
    if len(text) > max_len:
        text = text[:max_len - 3] + '...'
    return text

def _is_sized(value):
    # Only return True for types that _inspect_children_data can actually enumerate.
    # Generic objects that merely implement __len__ (e.g. bitarray) must not appear expandable.
    if isinstance(value, (dict, list, tuple, set, frozenset)):
        return True
    try:
        import numpy as np
        if isinstance(value, np.ndarray) and value.ndim >= 1:
            return True
    except Exception:
        pass
    return False

def _is_editable_scalar(value):
    import datetime as _dt
    return isinstance(value, (bool, int, float, str, bytes, bytearray,
                               _dt.datetime, _dt.date, _dt.time, _dt.timedelta))

def _is_ctor_repr(value):
    """Return True if value is a dataclass-like object whose repr contains
    keyword arguments (e.g. Point(x=1, y=2)).
    Accepts objects that are actual dataclasses, or whose repr looks like
    TypeName(field=val, ...) with at least one 'key=' pair inside.
    Used for the expandable-node decision in data mode.
    """
    if _is_editable_scalar(value) or _is_sized(value):
        return False
    # Fast-path: use dataclasses module if available
    try:
        import dataclasses
        if dataclasses.is_dataclass(value) and not isinstance(value, type):
            return True
    except Exception:
        pass
    # Fallback: check repr shape TypeName(identifier=..., ...)
    try:
        s = repr(value)
        tname = type(value).__name__
        if not (s.startswith(tname + '(') and s.endswith(')')):
            return False
        if re.search(r'\b0x[0-9a-fA-F]+\b', s):
            return False
        # Must have at least one 'identifier=' keyword argument inside the parens
        inner = s[len(tname) + 1:-1]
        return bool(re.search(r'[A-Za-z_][A-Za-z0-9_]*\s*=', inner))
    except Exception:
        return False

def _is_repr_editable(value):
    """Return True if the object has a constructor-like repr (TypeName(...)) with no
    hex address, making it sensible to display and edit as a string.
    This is the loose version of _is_ctor_repr — does NOT require keyword args.
    """
    if _is_editable_scalar(value) or _is_sized(value):
        return False
    try:
        s = repr(value)
        tname = type(value).__name__
        return (
            s.startswith(tname + '(')
            and s.endswith(')')
            and not re.search(r'\b0x[0-9a-fA-F]+\b', s)
        )
    except Exception:
        return False

def _build_accessor_for_key(key):
    return '[' + repr(key) + ']'

def _inspect_children_data(value, offset, limit):
    total = 0
    children = []

    if isinstance(value, dict):
        items = list(value.items())
        total = len(items)
        for key, child in items[offset:offset + limit]:
            children.append({
                'key': _short_repr(key, 80),
                'accessor': _build_accessor_for_key(key),
                'type': _type_name(child),
                'repr': _short_repr(child),
                'is_expandable': True,
                'is_sized': _is_sized(child),
                'is_ctor_repr': _is_ctor_repr(child),
                'is_ndarray': (type(child).__name__ == 'ndarray' and hasattr(child, 'shape')),
                'shape': str(child.shape) if hasattr(child, 'shape') and type(child).__name__ == 'ndarray' else None,
            })
        return total, children

    if isinstance(value, (list, tuple)):
        total = len(value)
        for idx in range(offset, min(total, offset + limit)):
            child = value[idx]
            children.append({
                'key': str(idx),
                'accessor': f'[{idx}]',
                'type': _type_name(child),
                'repr': _short_repr(child),
                'is_expandable': True,
                'is_sized': _is_sized(child),
                'is_ctor_repr': _is_ctor_repr(child),
                'is_ndarray': (type(child).__name__ == 'ndarray' and hasattr(child, 'shape')),
                'shape': str(child.shape) if hasattr(child, 'shape') and type(child).__name__ == 'ndarray' else None,
            })
        return total, children

    try:
        import numpy as np
        if isinstance(value, np.ndarray) and value.ndim >= 1:
            total = value.shape[0]
            for idx in range(offset, min(total, offset + limit)):
                child = value[idx]
                if value.ndim == 1:
                    # Leaf element: show type and value
                    children.append({
                        'key': str(idx),
                        'accessor': f'[{idx}]',
                        'type': str(value.dtype),
                        'repr': str(child),
                        'is_expandable': False,
                        'is_sized': False,
                        'is_ndarray': False,
                        'shape': None,
                    })
                else:
                    # Sub-array slice along axis 0
                    children.append({
                        'key': f'[{idx}]',
                        'accessor': f'[{idx}]',
                        'type': 'ndarray',
                        'repr': f'{child.dtype}  {list(child.shape)}',
                        'is_expandable': True,
                        'is_sized': True,
                        'is_ndarray': True,
                        'shape': str(child.shape),
                    })
            return total, children
    except Exception:
        pass

    if isinstance(value, (set, frozenset)):
        seq = list(value)
        total = len(seq)
        for idx in range(offset, min(total, offset + limit)):
            child = seq[idx]
            children.append({
                'key': str(idx),
                'accessor': None,
                'type': _type_name(child),
                'repr': _short_repr(child),
                'is_expandable': True,
                'is_sized': _is_sized(child),
                'is_ctor_repr': _is_ctor_repr(child),
            })
        return total, children

    # Fallback: not a data-container
    return 0, []

def _inspect_children_object(value, offset, limit, include_private=False):
    try:
        names = list(dict.fromkeys(dir(value)))
    except Exception:
        names = []

    public = [n for n in names if not n.startswith('_')]
    private = [n for n in names if n.startswith('_')]
    has_public = len(public) > 0
    merged = public[:]
    if has_public and private and not include_private:
        merged.append('__PYLOT_PRIVATE_GROUP__')
    else:
        merged.extend(private)

    total = len(merged)
    children = []
    for name in merged[offset:offset + limit]:
        if name == '__PYLOT_PRIVATE_GROUP__':
            children.append({
                'key': '_ ...',
                'accessor': None,
                'type': 'group',
                'repr': f'{len(private)} private attributes',
                'is_expandable': True,
                'is_sized': False,
                'is_private_group': True,
            })
            continue
        try:
            child = getattr(value, name)
            child_type = _type_name(child)
            child_repr = _short_repr(child)
            is_expandable = True # Every object can be expanded via dir() in object mode
            is_sized = _is_sized(child)
            is_ndarray = (child_type == 'ndarray' and hasattr(child, 'shape'))
            shape = str(child.shape) if is_ndarray else None
        except Exception as ex:
            child_type = 'error'
            child_repr = f'<error: {ex}>'
            is_expandable = False
            is_sized = False
            is_ndarray = False
            shape = None
        children.append({
            'key': name,
            'accessor': f'.{name}' if re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', name) else None,
            'type': child_type,
            'repr': child_repr,
            'is_expandable': is_expandable,
            'is_sized': is_sized,
            'is_ctor_repr': _is_ctor_repr(child) if is_expandable else False,
            'is_ndarray': is_ndarray,
            'shape': shape,
        })
    return total, children, has_public

def inspect_value(expression, mode='data', offset=0, limit=100, include_private=False):
    expr = (expression or '').strip()

    if expr:
        value = eval(expr, persistent_globals)
    else:
        value = persistent_globals

    value_type = type(value).__name__
    # Report the empty-expression (globals) view as 'globals' instead of 'dict'
    if expr == '':
        value_type = 'globals'
    # Report class definitions as 'class' instead of 'type'
    elif isinstance(value, type):
        value_type = 'class'
    is_ndarray = value_type == 'ndarray' and hasattr(value, 'shape') and hasattr(value, 'dtype')
    shape = str(value.shape) if is_ndarray else None
    dtype = str(value.dtype) if is_ndarray else None
    is_dataframe = False
    try:
        if hasattr(value, 'iloc') and hasattr(value, 'columns') and hasattr(value, 'dtypes'):
            is_dataframe = True
            shape = str(value.shape)
            dtypes_unique = value.dtypes.unique()
            dtype = str(dtypes_unique[0]) if len(dtypes_unique) == 1 else 'mixed'
    except Exception:
        pass
    is_editable = _is_editable_scalar(value)

    # For numpy scalars or 0-d arrays, we want them to be editable/viewable as scalars
    _is_np_scalar = False
    edit_hint = None
    try:
        import numpy as np
        if isinstance(value, (np.generic, np.ndarray)) and (not hasattr(value, 'shape') or value.shape == ()):
            _is_np_scalar = True
            kind = value.dtype.kind if hasattr(value, 'dtype') else None
            # Only kinds that can roundtrip from a user-entered string
            _NP_EDITABLE_KINDS = {'b', 'i', 'u', 'f', 'c', 'S', 'U', 'M'}
            if kind in _NP_EDITABLE_KINDS:
                is_editable = True
                if isinstance(value, np.bytes_):
                    # Use plain bytes repr so the editor shows b'...' instead of np.bytes_(b'...')
                    scalar_value = repr(bytes(value))
                else:
                    scalar_value = str(value)
                if kind == 'M':  # datetime64
                    edit_hint = 'ISO date, e.g. 2023-01-15 or 2023-01-15T12:00'
                elif kind == 'c':  # complex
                    edit_hint = 'e.g. 1+2j'
            else:
                # timedelta64, void, object — not reliably roundtrippable
                is_editable = False
                scalar_value = None
    except Exception:
        pass

    if not _is_np_scalar:
        import datetime as _dt
        if isinstance(value, (bytes, bytearray)):
            scalar_value = repr(value)
        elif isinstance(value, _dt.datetime):
            scalar_value = value.isoformat()
            edit_hint = 'ISO format, e.g. 2023-01-15T14:30:00'
        elif isinstance(value, _dt.date):
            scalar_value = value.isoformat()
            edit_hint = 'ISO format, e.g. 2023-01-15'
        elif isinstance(value, _dt.time):
            scalar_value = value.isoformat()
            edit_hint = 'ISO format, e.g. 14:30:00'
        elif isinstance(value, _dt.timedelta):
            scalar_value = str(int(value.total_seconds()))
            edit_hint = 'Total seconds as integer'
        elif is_editable:
            scalar_value = str(value)
        else:
            scalar_value = None

    # Bug fix: don't show container length for non-container types like int
    is_container = _is_sized(value)
    # Ensure is_container is false for non-containers even if they have __len__ by some fluke
    if not isinstance(value, (list, tuple, dict, set, frozenset, str, bytes, bytearray)) and not is_ndarray:
        is_container = False

    is_function = False
    func_params = None
    func_doc = None
    if not is_container and not is_ndarray and not isinstance(value, type) and callable(value):
        is_function = True
        import inspect as py_inspect
        try:
            func_doc = py_inspect.getdoc(value)
        except Exception:
            pass
        try:
            sig = py_inspect.signature(value)
            func_params = str(sig)
        except Exception:
            pass

    data_children = []
    total_count = 0
    has_public = False
    is_object_fallback = False

    if expr == '':
        names = sorted(persistent_globals.keys())
        public = [n for n in names if not n.startswith('_')]
        private = [n for n in names if n.startswith('_')]

        # If expression is empty (globals), we show children directly.
        # But if user requested specifically, include_private applies.
        merged = public[:]
        if private and not include_private:
            merged.append('__PYLOT_PRIVATE_GROUP__')
        else:
            merged.extend(private)

        total_count = len(merged)
        for name in merged[offset:offset + limit]:
            if name == '__PYLOT_PRIVATE_GROUP__':
                data_children.append({
                    'key': '_ ... (private variables)',
                    'accessor': None,
                    'type': 'group',
                    'repr': f'{len(private)} private variable' + ('s' if len(private) != 1 else ''),
                    'is_expandable': True,
                    'is_sized': False,
                    'is_private_group': True,
                })
                continue
            child = persistent_globals[name]
            data_children.append({
                'key': name,
                'accessor': name,
                'type': _type_name(child),
                'repr': _short_repr(child),
                'is_expandable': True,
                'is_sized': _is_sized(child),
                'is_ctor_repr': _is_ctor_repr(child),
                'is_ndarray': (type(child).__name__ == 'ndarray' and hasattr(child, 'shape')),
                'shape': str(child.shape) if hasattr(child, 'shape') and type(child).__name__ == 'ndarray' else None,
            })
        has_public = len(public) > 0
    elif mode == 'object':
        total_count, data_children, has_public = _inspect_children_object(value, offset, limit, include_private)
    else:
        total_count, data_children = _inspect_children_data(value, offset, limit)
        # Fallback for class objects that have no browsable data in data mode
        # (not a list/dict/ndarray/scalar/function).
        if total_count == 0 and not data_children and not is_editable and not is_function and not is_ndarray:
            _has_obj_addr = bool(re.search(r'\b0x[0-9a-fA-F]+\b', str(value)))
            _value_is_ctor_repr = _is_ctor_repr(value)
            _value_is_repr_editable = _is_repr_editable(value)
            if _value_is_ctor_repr:
                # Dataclass-like repr – show editable string and load attributes for tree expand.
                is_editable = True
                scalar_value = str(value)
                _attr_count, _attr_children, _has_public = _inspect_children_object(value, offset, limit, include_private)
                if _attr_children:
                    total_count, data_children, has_public = _attr_count, _attr_children, _has_public
            elif _value_is_repr_editable:
                # Constructor-like repr without keyword args (e.g. bitarray('00011011')):
                # show as editable string only, no attribute expansion.
                is_editable = True
                scalar_value = str(value)
            elif _has_obj_addr:
                # Repr contains a raw object address → meaningful __repr__ is missing.
                # Fall back to attribute list, but only when there are public attributes.
                _attr_count, _attr_children, _has_public = _inspect_children_object(value, offset, limit, include_private)
                if _attr_children and _has_public:
                    total_count, data_children, has_public = _attr_count, _attr_children, _has_public
                    is_object_fallback = True

    # For editable bytes/bytearray, report the byte length (children are not enumerated)
    if is_editable and isinstance(value, (bytes, bytearray)):
        total_count = len(value)

    return {
        'expression': expr,
        'type': value_type,
        'shape': shape,
        'dtype': dtype,
        'is_ndarray': is_ndarray,
        'is_dataframe': is_dataframe,
        'is_container': is_container,
        'is_editable_scalar': is_editable,
        'is_function': is_function,
        'func_params': func_params,
        'func_doc': func_doc,
        'scalar_value': scalar_value,
        'edit_hint': edit_hint,
        'str_value': str(value),
        'total_count': total_count,
        'children': data_children,
        'has_public': has_public,
        'is_object_fallback': is_object_fallback,
        'offset': offset,
        'limit': limit,
        'has_more': (offset + len(data_children)) < total_count,
    }

def set_scalar_value(expression, raw_value):
    expr = (expression or '').strip()
    if not expr:
        raise ValueError('Expression is empty')

    current = eval(expr, persistent_globals)
    text = '' if raw_value is None else str(raw_value)

    if isinstance(current, bool):
        value = text.strip().lower()
        if value in ('true', '1', 'yes', 'on'):
            parsed = True
        elif value in ('false', '0', 'no', 'off'):
            parsed = False
        else:
            raise ValueError('Boolean value must be true/false')
    elif isinstance(current, int) and not isinstance(current, bool):
        parsed = int(text.strip())
    elif isinstance(current, float):
        parsed = float(text.strip())
    elif isinstance(current, str):
        stripped = text.strip()
        try:
            lit = ast.literal_eval(stripped)
            parsed = str(lit)
        except Exception:
            parsed = text
    elif isinstance(current, (bytes, bytearray)):
        stripped = text.strip()
        # Accept np.bytes_(b'...') as well as plain b'...'
        m = re.match(r'^np\.bytes_\((b["\'].*["\'])\)$', stripped, re.DOTALL)
        if m:
            stripped = m.group(1)
        lit = ast.literal_eval(stripped)
        if not isinstance(lit, (bytes, bytearray)):
            raise ValueError("Value must be a bytes literal (e.g. b'...')")
        parsed = bytearray(lit) if isinstance(current, bytearray) else bytes(lit)
    else:
        import datetime as _dt
        if isinstance(current, _dt.datetime):
            try:
                parsed = _dt.datetime.fromisoformat(text.strip())
            except ValueError:
                raise ValueError("Expected ISO format, e.g. 2023-01-15T14:30:00")
        elif isinstance(current, _dt.date):
            try:
                parsed = _dt.date.fromisoformat(text.strip())
            except ValueError:
                raise ValueError("Expected ISO format, e.g. 2023-01-15")
        elif isinstance(current, _dt.time):
            try:
                parsed = _dt.time.fromisoformat(text.strip())
            except ValueError:
                raise ValueError("Expected ISO format, e.g. 14:30:00")
        elif isinstance(current, _dt.timedelta):
            try:
                parsed = _dt.timedelta(seconds=int(text.strip()))
            except ValueError:
                raise ValueError("Expected total seconds as integer, e.g. 3600")
        else:
            # Try numpy scalar types
            _handled_as_np = False
            try:
                import numpy as np
                if isinstance(current, (np.generic, np.ndarray)) and (not hasattr(current, 'shape') or current.shape == ()):
                    stripped = text.strip()
                    kind = current.dtype.kind if hasattr(current, 'dtype') else None
                    if isinstance(current, np.bool_):
                        lo = stripped.lower()
                        if lo in ('true', '1', 'yes', 'on'):
                            parsed = np.bool_(True)
                        elif lo in ('false', '0', 'no', 'off'):
                            parsed = np.bool_(False)
                        else:
                            raise ValueError('Boolean value must be true/false')
                    elif kind == 'M':  # datetime64
                        parsed = np.datetime64(stripped)
                    elif kind == 'c':  # complex
                        parsed = type(current)(complex(stripped))
                    elif isinstance(current, np.integer):
                        parsed = type(current)(int(stripped))
                    elif isinstance(current, np.floating):
                        parsed = type(current)(float(stripped))
                    elif isinstance(current, np.str_):
                        parsed = np.str_(stripped)
                    elif isinstance(current, np.bytes_):
                        m = re.match(r'^np\.bytes_\((b["\'].*["\'])\)$', stripped, re.DOTALL)
                        if m:
                            stripped = m.group(1)
                        lit = ast.literal_eval(stripped)
                        if not isinstance(lit, bytes):
                            raise ValueError("Value must be a bytes literal (e.g. b'...')")
                        parsed = np.bytes_(lit)
                    else:
                        raise ValueError(f'Type {type(current).__name__} is not editable in data mode')
                    _handled_as_np = True
            except ImportError:
                pass
            if not _handled_as_np:
                # Generic eval fallback: supports constructor-like repr edits
                # (e.g. user edits "Point(1, 2)" → "Point(3, 4)").
                try:
                    parsed = eval(text.strip(), persistent_globals)
                except Exception as _eval_err:
                    raise ValueError(f'Cannot parse value: {_eval_err}')

    persistent_globals['__pylot_tmp_set_value__'] = parsed
    try:
        exec(f"{expr} = __pylot_tmp_set_value__", persistent_globals)
    finally:
        persistent_globals.pop('__pylot_tmp_set_value__', None)

    return parsed

def custom_input(prompt=""):
    send_msg('input_request', prompt=str(prompt))
    reply = input_reply_queue.get()
    if reply is None:
        raise EOFError("EOF when reading a line")
    return reply

builtins.input = custom_input
builtins._pylot_progress = _pylot_progress
builtins._pylot_watch_names = _pylot_watch_names
builtins._pylot_watch_expr = _pylot_watch_expr
builtins._pylot_dump_json_safe = _pylot_dump_json_safe

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
                            # Cast value to the array's dtype, then assign
                            try:
                                import numpy as np
                                if hasattr(obj, 'dtype') and obj.dtype.kind == 'M':
                                    # datetime64: value is the raw int64 unit count
                                    obj.view(np.int64)[tuple(int(i) for i in indices)] = int(raw_value)
                                else:
                                    try:
                                        raw_value = type(obj.flat[0])(raw_value)
                                    except Exception:
                                        pass
                                    obj[tuple(int(i) for i in indices)] = raw_value
                            except ImportError:
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
                    elif action == 'inspect_async':
                        req_id = command.get('requestId')
                        try:
                            expression = command.get('expression', '')
                            mode = command.get('mode', 'data')
                            offset = int(command.get('offset', 0) or 0)
                            limit = int(command.get('limit', 100) or 100)
                            include_private = bool(command.get('includePrivate', False))
                            payload = inspect_value(expression, mode, offset, limit, include_private)
                            kwargs = dict(success=True, payload=json.dumps(payload))
                            if req_id is not None:
                                kwargs['requestId'] = req_id
                            send_msg('inspect_async', **kwargs)
                        except Exception as e:
                            kwargs = dict(success=False, error=str(e))
                            if req_id is not None:
                                kwargs['requestId'] = req_id
                            send_msg('inspect_async', **kwargs)
                        continue
                    elif action == 'set_value_async':
                        req_id = command.get('requestId')
                        try:
                            expression = command.get('expression', '')
                            raw_value = command.get('value', '')
                            set_scalar_value(expression, raw_value)
                            kwargs = dict(success=True)
                            if req_id is not None:
                                kwargs['requestId'] = req_id
                            send_msg('set_value_async', **kwargs)
                        except Exception as e:
                            kwargs = dict(success=False, error=str(e))
                            if req_id is not None:
                                kwargs['requestId'] = req_id
                            send_msg('set_value_async', **kwargs)
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

