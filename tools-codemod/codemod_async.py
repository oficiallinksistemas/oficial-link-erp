#!/usr/bin/env python3
"""
Codemod Oficial Link ERP: conversao sync -> async (Fase 1 da migracao Cloudflare).

Estrategia: await sobre valores sincronos e semanticamente inocuo, entao a
transformacao e validada pelos 258 testes originais rodando sobre o SQLite
classico ANTES de qualquer contato com o D1.

Regras:
 1. await em cadeias inline  db.prepare(...).(get|all|run)(
 2. await em statement vars  const stmt = db.prepare(...); stmt.run(
 3. await em db.exec(
 4. await propagado em chamadas a funcoes que viraram async (locais + imports)
 5. async-ificacao de qualquer funcao que passou a conter await
 6. CORPOS de db.transaction(...) sao PRESERVADOS sincronos (skip) —
    conversao para D1 batch() e o bloco 2 da migracao, manual, uma a uma.
 7. audit() NUNCA recebe await (fire-and-forget por design do sistema).
"""
import os, re, sys, json, functools

WORK = "/mnt/agents/output/work/oficial-link-erp-cloudflare"
SRC = os.path.join(WORK, "server", "src")
EXCLUDE_DIRS = ("database",)          # adapter e migrations: escrita manual
EXCLUDE_FILES = {"app.js"}            # hand-convertido (static assets mudam)
NEVER_AWAIT = {"audit"}               # fire-and-forget intencional
KEYWORDS = {"if","for","while","switch","catch","return","function","else","do",
            "new","typeof","await","async","case","delete","void","in","of",
            "try","finally","throw","yield","instanceof"}

# ---------------------------------------------------------------- mascara de strings
def code_mask(txt):
    """mask[i]=True se caractere i e codigo. Suporta template literals com
    expressoes ${...} aninhadas (codigo dentro de template e codigo real)."""
    mask = bytearray(b"\x01") * len(txt)
    n = len(txt)

    def scan_string(i, q):
        """marca string comecando em i; retorna posicao apos fechamento."""
        mask[i] = 0; i += 1
        while i < n:
            c = txt[i]
            if c == "\\":
                mask[i] = 0
                if i + 1 < n: mask[i+1] = 0
                i += 2; continue
            if q != "`" and c == "\n":
                return i  # string nao-finalizada (erro de parse); segue em frente
            if c == q:
                mask[i] = 0; i += 1; return i
            if q == "`" and c == "$" and i + 1 < n and txt[i+1] == "{":
                # expressao de template: codigo real ate '}' correspondente
                mask[i] = 0; mask[i+1] = 0; i += 2
                depth = 1
                while i < n and depth > 0:
                    c2 = txt[i]
                    if c2 in "'\"`":
                        i = scan_string(i, c2); continue
                    if c2 == "{":
                        depth += 1; mask[i] = 1
                    elif c2 == "}":
                        depth -= 1; mask[i] = 1 if depth > 0 else 0
                        if depth == 0: i += 1; break
                    else:
                        mask[i] = 1
                    i += 1
                continue
            mask[i] = 0; i += 1
        return i

    i = 0
    while i < n:
        c = txt[i]
        if c in "'\"`":
            i = scan_string(i, c)
        elif c == "/" and i + 1 < n and txt[i+1] == "/":
            while i < n and txt[i] != "\n": mask[i] = 0; i += 1
        elif c == "/" and i + 1 < n and txt[i+1] == "*":
            mask[i] = 0; mask[i+1] = 0; i += 2
            while i + 1 < n and not (txt[i] == "*" and txt[i+1] == "/"):
                mask[i] = 0; i += 1
            mask[i] = 0; mask[i+1:i+2] = b"\x00"; i += 2
        else:
            i += 1
    return mask

def match_fwd(txt, mask, i, open_c="(", close_c=")"):
    """indice do fechamento correspondente; -1 se nao achar. i aponta para open_c."""
    depth = 0
    j, n = i, len(txt)
    while j < n:
        if mask[j]:
            if txt[j] == open_c: depth += 1
            elif txt[j] == close_c:
                depth -= 1
                if depth == 0: return j
        j += 1
    return -1

def prev_word(txt, mask, pos):
    """palavra anterior a pos (so codigo)."""
    j = pos - 1
    while j >= 0 and txt[j] in " \t\r\n": j -= 1
    end = j + 1
    while j >= 0 and (txt[j].isalnum() or txt[j] in "_$"): j -= 1
    return txt[j+1:end]

def prev_nonspace(txt, pos):
    j = pos - 1
    while j >= 0 and txt[j] in " \t\r\n": j -= 1
    return txt[j] if j >= 0 else ""

# ---------------------------------------------------------------- deteccao de nos
class Node:
    __slots__ = ("start", "sig", "body_start", "body_end", "name", "kind")
    def __init__(s, start, sig, body_start, body_end, name, kind):
        s.start, s.sig, s.body_start, s.body_end, s.name, s.kind = start, sig, body_start, body_end, name, kind

def find_nodes(txt, mask):
    nodes = []
    n = len(txt)

    def add_arrow(pos_arrow):
        """pos_arrow: indice do '=' do '=>'. Procura params atras; body a frente."""
        j = pos_arrow - 1
        while j >= 0 and txt[j] in " \t": j -= 1
        if j >= 0 and txt[j] == ")":
            k = j - 1; depth = 1
            while k >= 0:
                if mask[k]:
                    if txt[k] == ")": depth += 1
                    elif txt[k] == "(":
                        depth -= 1
                        if depth == 0: break
                k -= 1
            pstart = k
        elif j >= 0 and (txt[j].isalnum() or txt[j] in "_$"):
            k = j
            while k >= 0 and (txt[k].isalnum() or txt[k] in "_$"): k -= 1
            pstart = k + 1
        else:
            return
        # procurar '=' antes dos params; aceitar prefixo 'async' (arrow ja
        # async) e posicao de argumento anonima
        k = pstart - 1
        while k >= 0 and txt[k] in " \t": k -= 1
        ja_async = False
        if k >= 0 and (txt[k].isalnum() or txt[k] in "_$"):
            k2 = k
            while k2 >= 0 and (txt[k2].isalnum() or txt[k2] in "_$"): k2 -= 1
            if txt[k2+1:k+1] == "async":
                ja_async = True
                k = k2
                while k >= 0 and txt[k] in " \t": k -= 1
        nm = None
        if k >= 0 and txt[k] == "=":
            # capturar nome: 'const NAME = (...) =>' / 'NAME: (...) =>'
            k2 = k - 1
            while k2 >= 0 and txt[k2] in " \t": k2 -= 1
            if k2 >= 0 and (txt[k2].isalnum() or txt[k2] in "_$"):
                k3 = k2
                while k3 >= 0 and (txt[k3].isalnum() or txt[k3] in "_$"): k3 -= 1
                cand = txt[k3+1:k2+1]
                pw = prev_word(txt, mask, k3+1)
                if pw in ("const", "let", "var") or prev_nonspace(txt, k3+1) in "{,":
                    nm = cand
        if k < 0 or txt[k] != "=":
            if ja_async:
                pass
            else:
                p = prev_nonspace(txt, pstart)
                if p and (p.isalnum() or p in "_$"): return
                if p in ".=:([{,;>!&|?+-*/%": pass
                elif p in "": pass
                else: return
        # body
        b = pos_arrow + 2
        while b < n and txt[b] in " \t": b += 1
        if b < n and txt[b] == "{":
            be = match_fwd(txt, mask, b, "{", "}")
            if be == -1: return
            nodes.append(Node(pstart, pstart, b, be, nm, "arrow"))
        else:
            # expressao: ate ; ou , ou ) de depth 0 ou \n em depth 0
            depth = 0; k = b
            while k < n:
                if mask[k]:
                    if txt[k] in "([{": depth += 1
                    elif txt[k] in ")]}":
                        if depth == 0: break
                        depth -= 1
                    elif depth == 0 and txt[k] in ";,\n": break
                k += 1
            nodes.append(Node(pstart, pstart, b, k, nm, "arrowexpr"))

    # 1) function declarations / expressions
    for m in re.finditer(r"\bfunction\b", txt):
        if not mask[m.start()]: continue
        j = m.end()
        while j < n and txt[j] in " \t": j += 1
        nm = None
        if j < n and (txt[j].isalnum() or txt[j] in "_$"):
            k = j
            while k < n and (txt[k].isalnum() or txt[k] in "_$"): k += 1
            nm = txt[j:k]; j = k
        while j < n and txt[j] in " \t\r\n": j += 1
        if j >= n or txt[j] != "(": continue
        pe = match_fwd(txt, mask, j)
        if pe == -1: continue
        b = pe + 1
        while b < n and txt[b] in " \t\r\n": b += 1
        if b >= n or txt[b] != "{": continue
        be = match_fwd(txt, mask, b, "{", "}")
        if be == -1: continue
        nodes.append(Node(m.start(), m.start(), b, be, nm, "function"))

    # 2) object methods  name(args) {   (palavra-chave excluida, prev nao e . = )
    for m in re.finditer(r"([A-Za-z_$][\w$]*)\s*\(", txt):
        if not mask[m.start()]: continue
        nm = m.group(1)
        if nm in KEYWORDS: continue
        pe = match_fwd(txt, mask, m.end() - 1)
        if pe == -1: continue
        b = pe + 1
        while b < n and txt[b] in " \t\r\n": b += 1
        if b >= n or txt[b] != "{": continue
        p = prev_nonspace(txt, m.start())
        if p in ".=(:,!&|?{}[];>" or (p and (p.isalnum() or p in "_$")): continue
        # prev word nao pode ser keyword tipo return
        pw = prev_word(txt, mask, m.start())
        if pw in KEYWORDS: continue
        be = match_fwd(txt, mask, b, "{", "}")
        if be == -1: continue
        nodes.append(Node(m.start(), m.start(), b, be, nm, "method"))

    # 3) arrows  =>  (inclui anonimas e const name = ... =>)
    for m in re.finditer(r"=>", txt):
        if not mask[m.start()]: continue
        # ignorar '=>' dentro de '<=' nao ocorre em js; ok
        add_arrow(m.start())

    # dedup por body_start
    seen = {}
    for nd in nodes:
        seen.setdefault(nd.body_start, nd)
    return sorted(seen.values(), key=lambda x: x.body_start)

def enclosing_node(nodes, pos):
    best = None
    for nd in nodes:
        if nd.body_start <= pos <= nd.body_end:
            if best is None or nd.body_start > best.body_start: best = nd
    return best


# ---------------------------------------------------------------- exports por modulo
def export_names(txt, mask, nodes):
    """nome -> True se a funcao exportada e async (contem await)."""
    awaits = set()
    for m in re.finditer(r"\bawait\b", txt):
        if mask[m.start()]:
            nd = enclosing_node(nodes, m.start())
            if nd: awaits.add(nd.body_start)
    node_by_name = {}
    for nd in nodes:
        if nd.name: node_by_name.setdefault(nd.name, nd)
    async_names = {nm for nm, nd in node_by_name.items() if nd.body_start in awaits}

    exports = {}
    for m in re.finditer(r"module\.exports\s*=\s*\{", txt):
        if not mask[m.start()]: continue
        be = match_fwd(txt, mask, m.end() - 1, "{", "}")
        if be == -1: continue
        inner = txt[m.end():be]
        base_off = m.end()
        for km in re.finditer(r"([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?\s*,?", inner):
            key = km.group(1)
            if key in ("module", "exports"): continue
            val = km.group(2) or key
            if val in async_names: exports[key] = True
            elif val in node_by_name: exports[key] = False
            else:
                # arrow inline? 'key: (args) => { ... }' ou 'key: arg => ...'
                seg = inner[km.end():]
                am = re.match(r"\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>", seg)
                if am:
                    abs_pos = base_off + km.end() + am.end() - 2  # no '=>'
                    nd = enclosing_node(nodes, abs_pos)
                    if nd is not None and nd.kind.startswith("arrow"):
                        seg2 = txt[nd.body_start:nd.body_end]
                        mask2 = mask
                        has = any(mask2[mm.start()] for mm in re.finditer(r"\bawait\b", seg2))
                        exports[key] = bool(has)
                    else:
                        exports.setdefault(key, None)
                else:
                    exports.setdefault(key, None)
    # module.exports.name = ...
    for m in re.finditer(r"module\.exports\.([A-Za-z_$][\w$]*)\s*=", txt):
        if not mask[m.start()]: continue
        exports.setdefault(m.group(1), None)
    return exports, node_by_name, awaits

# ---------------------------------------------------------------- regras de await
def collect_insertions(txt, mask, nodes, skip_ranges, local_async, import_async):
    """retorna lista de posicoes onde inserir 'await '."""
    ins = []
    n = len(txt)

    def skipped(pos):
        return any(a <= pos <= b for a, b in skip_ranges)

    def already_awaited(pos):
        return prev_word(txt, mask, pos) == "await"

    def prev_is_dot(pos):
        return prev_nonspace(txt, pos) == "."

    # --- 1) cadeias inline db.prepare(...).method(
    for m in re.finditer(r"\bdb\.prepare\(", txt):
        if not mask[m.start()] or skipped(m.start()): continue
        pe = match_fwd(txt, mask, m.end() - 1)
        if pe == -1: continue
        j = pe + 1
        while j < n and txt[j] in " \t\r\n": j += 1
        mm = re.match(r"\.(get|all|run)\s*\(", txt[j:])
        if mm and not already_awaited(m.start()):
            ins.append(m.start())

    # --- 2) statement vars
    for m in re.finditer(r"(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*db\.prepare\(", txt):
        if not mask[m.start()] or skipped(m.start()): continue
        name = m.group(1)
        pe = match_fwd(txt, mask, m.end() - 1)
        if pe == -1: continue
        nxt = pe + 1
        while nxt < n and txt[nxt] in " \t\r\n": nxt += 1
        if nxt < n and txt[nxt] == ".":  # cadeia inline; ja tratada em (1)
            continue
        for um in re.finditer(r"\b" + re.escape(name) + r"\.(get|all|run)\s*\(", txt):
            if not mask[um.start()] or skipped(um.start()): continue
            if already_awaited(um.start()) or prev_is_dot(um.start()): continue
            ins.append(um.start())

    # --- 3) db.exec(
    for m in re.finditer(r"\bdb\.exec\(", txt):
        if not mask[m.start()] or skipped(m.start()): continue
        if not already_awaited(m.start()): ins.append(m.start())

    # --- 4) chamadas a funcoes async (locais e via imports)
    def callee_calls(names):
        if not names: return
        pat = re.compile(r"\b(" + "|".join(re.escape(x) for x in names) + r")\s*\(")
        for m in pat.finditer(txt):
            if not mask[m.start()] or skipped(m.start()): continue
            nm = m.group(1)
            if nm in KEYWORDS or nm in NEVER_AWAIT: continue
            if already_awaited(m.start()) or prev_is_dot(m.start()): continue
            pw = prev_word(txt, mask, m.start())
            if pw in ("function", "async", "new", "typeof", "case", "delete"): continue
            # nao e' definicao (async-ificacao cuida); so chamadas
            ins.append(m.start())

    callee_calls(local_async)
    # nomes destruturados de require ('<dest>') sao callees simples, nao var.metodo
    plain = {var for var, meths in import_async.items() if "<dest>" in meths}
    callee_calls(plain)
    for var, meths in import_async.items():
        if "<dest>" in meths: continue
        good = {k for k, v in meths.items() if v}
        if not good: continue
        pat = re.compile(r"\b" + re.escape(var) + r"\.(" + "|".join(re.escape(x) for x in good) + r")\s*\(")
        for m in pat.finditer(txt):
            if not mask[m.start()] or skipped(m.start()): continue
            if already_awaited(m.start()): continue
            ins.append(m.start())
    return sorted(set(ins))

def resolve_imports(txt, mask, module_exports, cur_rel):
    """var de require -> {metodo: async?} ; e nomes destruturados -> async?
    resolve caminhos relativos a partir do arquivo corrente."""
    def resolve(rel):
        if not rel.startswith("."):
            return None
        base = os.path.dirname(cur_rel)
        cand = os.path.normpath(os.path.join(base, rel))
        for k in (cand + ".js", os.path.join(cand, "index.js"), cand):
            if k in module_exports: return k
        return None
    var_map = {}
    dest_map = {}
    for m in re.finditer(r"const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(['\"]([^'\"]+)['\"]\)", txt):
        if not mask[m.start()]: continue
        var_map[m.group(1)] = m.group(2)
    for m in re.finditer(r"const\s*\{([^}]*)\}\s*=\s*require\(['\"]([^'\"]+)['\"]\)", txt):
        if not mask[m.start()]: continue
        names = [x.strip().split(":")[0].strip() for x in m.group(1).split(",") if x.strip()]
        dest_map[m.group(2)] = names
    out_var = {}
    for var, rel in var_map.items():
        key = resolve(rel)
        if key: out_var[var] = module_exports[key]
    out_dest = {}
    for rel, names in dest_map.items():
        key = resolve(rel)
        if not key: continue
        exp = module_exports.get(key, {})
        for nm in names:
            if nm in exp: out_dest[nm] = exp[nm]
    return out_var, out_dest

# ---------------------------------------------------------------- skip: corpos db.transaction
def tx_skip_ranges(txt, mask):
    ranges = []
    for m in re.finditer(r"\bdb\.transaction\(", txt):
        if not mask[m.start()]: continue
        j = m.end()
        while j < len(txt) and txt[j] in " \t\r\n": j += 1
        if j < len(txt) and txt[j] == "(":
            pe = match_fwd(txt, mask, j)
            if pe == -1: continue
            b = pe + 1
            while b < len(txt) and txt[b] in " \t\r\n": b += 1
        elif txt.startswith("function", j):
            bm = re.match(r"function\s*[A-Za-z_$]*\s*\(", txt[j:])
            if not bm: continue
            pe = match_fwd(txt, mask, j + bm.end() - 1)
            if pe == -1: continue
            b = pe + 1
            while b < len(txt) and txt[b] in " \t\r\n": b += 1
        else:
            continue
        if b < len(txt) and txt[b] == "{":
            be = match_fwd(txt, mask, b, "{", "}")
            if be != -1: ranges.append((b, be))
        else:
            # arrow de expressao unica: pular ate o ';' que encerra o
            # statement (ou o ')' que fecha a chamada db.transaction(...)(...))
            depth = 0; k = b
            while k < len(txt):
                if mask[k]:
                    if txt[k] in "([{": depth += 1
                    elif txt[k] in ")]}":
                        if depth == 0: break
                        depth -= 1
                    elif depth == 0 and txt[k] == ";": break
                k += 1
            ranges.append((b, k))
    return ranges

# ---------------------------------------------------------------- async-ificacao
def asyncify(txt, mask, nodes, awaits_positions):
    """insere 'async' nas funcoes que contem await. retorna (novo_txt, set(body_starts asyncs))."""
    to_async = set()
    for ap in awaits_positions:
        nd = enclosing_node(nodes, ap)
        if nd: to_async.add(nd.body_start)
    # expressoes de arrow que retornam promise e precisam de async
    edits = []
    done = set()
    for nd in nodes:
        if nd.body_start not in to_async or nd.body_start in done: continue
        done.add(nd.body_start)
        if prev_word(txt, mask, nd.start) == "async":
            continue  # ja async
        if nd.kind == "function":
            fm = re.search(r"\bfunction\b", txt[nd.start:nd.body_start])
            pos = nd.start + fm.start()
            edits.append((pos, "async "))
        elif nd.kind in ("arrow", "arrowexpr"):
            # inserir antes dos params (nd.sig = inicio dos params)
            edits.append((nd.sig, "async "))
        elif nd.kind == "method":
            edits.append((nd.start, "async "))
    if not edits: return txt, set()
    for pos, s in sorted(edits, reverse=True):
        txt = txt[:pos] + s + txt[pos:]
    return txt, to_async

# ---------------------------------------------------------------- main
def write_robust(path, content):
    tmp = path + ".tmpcodemod"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(content)
    try:
        os.replace(tmp, path)
    except PermissionError:
        os.unlink(path)
        os.replace(tmp, path)

def iter_files():
    for dp, dn, fn in os.walk(SRC):
        rel_dir = os.path.relpath(dp, SRC)
        if any(rel_dir == d or rel_dir.startswith(d + os.sep) for d in EXCLUDE_DIRS):
            continue
        for f in fn:
            if f.endswith(".js") and f not in EXCLUDE_FILES:
                yield os.path.join(dp, f)

def rel_module_key(path):
    # chave normalizada como aparece nos requires relativos
    return os.path.relpath(path, SRC)

def main():
    files = list(iter_files())
    texts = {p: open(p, encoding="utf-8").read() for p in files}
    stats = {"await_inserted": 0, "asyncified": 0, "rounds": 0}

    for round_no in range(12):
        stats["rounds"] = round_no + 1
        changed_any = False
        masks, nodes_by = {}, {}
        skips = {}
        for p in files:
            masks[p] = code_mask(texts[p])
            nodes_by[p] = find_nodes(texts[p], masks[p])
            skips[p] = tx_skip_ranges(texts[p], masks[p])

        # exports async por modulo (chave = caminho relativo normalizado)
        module_exports = {}
        export_cache = {}
        for p in files:
            exp, _, _ = export_names(texts[p], masks[p], nodes_by[p])
            export_cache[p] = exp
            module_exports[rel_module_key(p)] = exp

        for p in files:
            txt = texts[p]
            exp, node_by_name, _ = export_names(txt, masks[p], nodes_by[p])
            local_async = {nm for nm, nd in node_by_name.items()
                           if any(enclosing_node(nodes_by[p], m.start()) is nd
                                  for m in re.finditer(r"\bawait\b", txt) if masks[p][m.start()])}
            imp_var, imp_dest = resolve_imports(txt, masks[p], module_exports, rel_module_key(p))
            import_async = dict(imp_var)
            for nm, is_async in imp_dest.items():
                if is_async: import_async[nm] = {"<dest>": True}

            ins = collect_insertions(txt, masks[p], nodes_by[p], skips[p], local_async, import_async)
            if not ins: continue
            for pos in sorted(ins, reverse=True):
                txt = txt[:pos] + "await " + txt[pos:]
            texts[p] = txt
            stats["await_inserted"] += len(ins)
            changed_any = True

        # async-ificacao apos todas as insercoes da rodada
        for p in files:
            txt = texts[p]
            mask = code_mask(txt)
            nodes = find_nodes(txt, mask)
            awaits_pos = [m.start() for m in re.finditer(r"\bawait\b", txt) if mask[m.start()]]
            new_txt, _ = asyncify(txt, mask, nodes, awaits_pos)
            if new_txt != txt:
                stats["asyncified"] += 1
                texts[p] = new_txt
                changed_any = True

        if not changed_any:
            break

    for p in files:
        write_robust(p, texts[p])

    # relatorio: funcoes async por arquivo + tx preservadas
    report = []
    for p in files:
        txt = texts[p]
        mask = code_mask(txt)
        nodes = find_nodes(txt, mask)
        awaits_pos = [m.start() for m in re.finditer(r"\bawait\b", txt) if mask[m.start()]]
        names = []
        for nd in nodes:
            if any(enclosing_node(nodes, ap) is nd for ap in awaits_pos):
                line = txt[:nd.start].count("\n") + 1
                nm = nd.name or "(anon)"
                names.append(f"{nm}@{line}")
        txs = len(re.findall(r"\bdb\.transaction\(", txt))
        if names or txs:
            report.append(f"{os.path.relpath(p, WORK)}: async=[{', '.join(names)}] tx={txs}")
    print("\n".join(report))
    print(json.dumps(stats))

if __name__ == "__main__":
    main()
