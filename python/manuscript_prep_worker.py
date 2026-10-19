#!/usr/bin/env python
"""TXT-only Manuscript Prep JSONL worker. stdout is protocol only."""
from __future__ import annotations
import hashlib, json, os, re, shutil, sys, tempfile, unicodedata, uuid, zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

VERSION = 1
MAX_INPUT_BYTES = 25 * 1024 * 1024
WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W = "{" + WORD_NS + "}"

for _stream in (sys.stdin, sys.stdout, sys.stderr):
    _reconfigure = getattr(_stream, 'reconfigure', None)
    if callable(_reconfigure): _reconfigure(encoding='utf-8', errors='strict')

def emit(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")), flush=True)
def now() -> str: return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
def sha(data: bytes) -> str: return hashlib.sha256(data).hexdigest()
def error(code: str, message: str, retryable: bool = False) -> dict[str, Any]: return {"code":code,"message":message,"retryable":retryable}
def safe_id(value: Any, prefix: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(prefix + r"[A-Za-z0-9-]{1,100}", value): raise ValueError("INVALID_REQUEST")
    return value
def result(request_id: str, payload: Any = None, err: dict[str, Any] | None = None) -> None:
    value: dict[str, Any] = {"kind":"result","protocolVersion":VERSION,"requestId":request_id,"ok":err is None}
    if err is None: value["payload"] = payload
    else: value["error"] = err
    emit(value)
def root_for(payload: dict[str, Any]) -> Path:
    root = Path(str(payload.get("projectRoot") or "")).resolve()
    if not root.name or not (root / "manuscript-prep").is_dir(): raise RuntimeError("UNSAFE_PATH")
    return root
def atomic_json(path: Path, value: Any) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)
def draft_path(root: Path, draft_id: str) -> Path: return root / "manuscript-prep" / "drafts" / draft_id / "draft.json"
def read_draft(root: Path, draft_id: str) -> dict[str, Any]:
    target = draft_path(root, draft_id)
    if not target.is_file(): raise FileNotFoundError()
    return json.loads(target.read_text(encoding="utf-8"))
def write_draft(root: Path, draft: dict[str, Any]) -> None: atomic_json(draft_path(root, draft["draftId"]), draft)
def write_review_patch(root: Path, draft: dict[str, Any]) -> None:
    atomic_json(draft_path(root, draft["draftId"]).with_name("review.patch.json"), {"baseRevision": 1, "operations": draft["reviewOperations"]})
def source_bytes(source: dict[str, Any]) -> bytes:
    raw_path = source.get("canonicalPath")
    if not isinstance(raw_path, str): raise RuntimeError("UNSAFE_PATH")
    target = Path(raw_path)
    if target.is_symlink() or not target.is_file(): raise FileNotFoundError()
    data = target.read_bytes()
    if len(data) > MAX_INPUT_BYTES: raise RuntimeError("INPUT_LIMIT_EXCEEDED")
    if sha(data) != source.get("expectedSha256"): raise RuntimeError("SOURCE_CHANGED")
    return data
def decode_txt(data: bytes) -> str:
    if data.startswith(b'\xef\xbb\xbf'): return data[3:].decode('utf-8')
    if data.startswith(b'\xff\xfe'): return data[2:].decode('utf-16-le')
    if data.startswith(b'\xfe\xff'): return data[2:].decode('utf-16-be')
    return data.decode('utf-8')
def normalized(text: str) -> str: return unicodedata.normalize('NFC', text.replace('\r\n','\n').replace('\r','\n'))
def docx_text(paragraph: ET.Element) -> str:
    parts: list[str] = []
    for node in paragraph.iter():
        if node.tag == W + 't': parts.append(node.text or '')
        elif node.tag == W + 'tab': parts.append('\t')
        elif node.tag in (W + 'br', W + 'cr'): parts.append('\n')
    return normalized(''.join(parts))
def docx_style(paragraph: ET.Element) -> tuple[str | None, int | None]:
    style = paragraph.find('./' + W + 'pPr/' + W + 'pStyle')
    style_id = style.get(W + 'val') if style is not None else None
    match = re.fullmatch(r'(?:Heading|heading)[ _-]?(\d+)', style_id or '')
    return style_id, int(match.group(1)) if match else None
def docx_paragraph_block(paragraph: ET.Element, order: int, paragraph_index: int, story: str, in_table: bool = False) -> dict[str, Any] | None:
    text = docx_text(paragraph)
    if not text: return None
    style_id, heading_level = docx_style(paragraph)
    return {"id":f"block_{uuid.uuid4().hex}","position":order,"type":"heading" if heading_level else "note" if story in ("footnote", "endnote") else "paragraph","generatedText":text,"included":True,"source":{"documentOrder":order,"paragraphIndex":paragraph_index,"story":story,"styleId":style_id,"headingLevel":heading_level,"inTable":in_table}}
def docx_extract(data: bytes) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, int]]:
    try: archive = zipfile.ZipFile(__import__('io').BytesIO(data))
    except (zipfile.BadZipFile, OSError): raise RuntimeError("SOURCE_UNREADABLE")
    if 'word/document.xml' not in archive.namelist(): raise RuntimeError("UNSUPPORTED_FORMAT")
    try: document = ET.fromstring(archive.read('word/document.xml'))
    except ET.ParseError: raise RuntimeError("SOURCE_UNREADABLE")
    body = document.find('.//' + W + 'body')
    if body is None: raise RuntimeError("EXTRACTION_FAILED")
    blocks: list[dict[str, Any]] = []; diagnostics: list[dict[str, Any]] = []; order = 0; paragraph_index = 0; table_count = 0; unsupported = 0
    for child in list(body):
        if child.tag == W + 'p':
            block = docx_paragraph_block(child, order, paragraph_index, 'body'); paragraph_index += 1
            if block: blocks.append(block); order += 1
        elif child.tag == W + 'tbl':
            table_count += 1
            for paragraph in child.findall('.//' + W + 'p'):
                block = docx_paragraph_block(paragraph, order, paragraph_index, 'body', True); paragraph_index += 1
                if block: blocks.append(block); order += 1
        elif child.tag not in (W + 'sectPr',): unsupported += 1
    note_count = 0
    for story, filename, tag in [('footnote','word/footnotes.xml', W + 'footnote'), ('endnote','word/endnotes.xml', W + 'endnote')]:
        if filename not in archive.namelist(): continue
        try: notes = ET.fromstring(archive.read(filename))
        except ET.ParseError: diagnostics.append({"id":f"{story}-unreadable","severity":"check","category":"notes","message":f"{story.title()} XML could not be read; review source document.","suggestedAction":"Review notes in Word."}); continue
        for note in notes.findall('./' + tag):
            for paragraph in note.findall('./' + W + 'p'):
                block = docx_paragraph_block(paragraph, order, paragraph_index, story); paragraph_index += 1
                if block: blocks.append(block); order += 1; note_count += 1
    header_footer_count = 0
    for name in archive.namelist():
        if not re.fullmatch(r'word/(header|footer)\d+\.xml', name): continue
        story = 'header' if '/header' in name else 'footer'
        try: root = ET.fromstring(archive.read(name))
        except ET.ParseError: continue
        for paragraph in root.findall('.//' + W + 'p'):
            block = docx_paragraph_block(paragraph, order, paragraph_index, story); paragraph_index += 1
            if block: blocks.append(block); order += 1; header_footer_count += 1
    if table_count: diagnostics.append({"id":"tables","severity":"check","category":"tables","message":f"{table_count} table(s) were retained as document-order text blocks.","suggestedAction":"Review table reading order."})
    if note_count: diagnostics.append({"id":"notes","severity":"check","category":"notes","message":f"{note_count} footnote/endnote paragraph(s) were retained after body text.","suggestedAction":"Review whether notes should be narrated."})
    if header_footer_count: diagnostics.append({"id":"headers-footers","severity":"check","category":"repeated_headers_footers","message":f"{header_footer_count} header/footer paragraph(s) were retained after body text.","suggestedAction":"Review repeated header/footer content."})
    if any(name.startswith('word/media/') or name.startswith('word/embeddings/') for name in archive.namelist()): diagnostics.append({"id":"embedded-content","severity":"check","category":"embedded_content","message":"The DOCX contains embedded media or objects that are not converted to text.","suggestedAction":"Review the original document for non-text content."})
    if unsupported: diagnostics.append({"id":"structure","severity":"check","category":"suspicious_structure_loss","message":f"{unsupported} unsupported body structure element(s) were not represented as text.","suggestedAction":"Review the original document structure."})
    return blocks, diagnostics, {"paragraphCount": paragraph_index, "tableCount": table_count, "noteCount": note_count, "headerFooterCount": header_footer_count}
def docx_review_diagnostics(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Add explicit, non-destructive narrator decisions for material DOCX stories."""
    diagnostics: list[dict[str, Any]] = []; header_footer: list[dict[str, Any]] = []
    for block in blocks:
        source = block.get("source", {}); block_id = block["id"]
        if source.get("inTable"):
            diagnostics.append({"id":f"review-table-{block_id}","severity":"review_required","category":"tables","message":"A table text item is retained. Decide whether it belongs in the narration manuscript.","suggestedAction":"Keep it included or exclude this item.","blockIds":[block_id]})
        if source.get("story") in ("footnote", "endnote"):
            diagnostics.append({"id":f"review-note-{block_id}","severity":"review_required","category":"notes","message":"A note or endnote item is retained. Decide whether it belongs in the narration manuscript.","suggestedAction":"Keep it included or exclude this item.","blockIds":[block_id]})
        if source.get("story") in ("header", "footer"): header_footer.append(block)
    repeated: set[str] = set(); groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for block in header_footer: groups.setdefault((str(block["source"]["story"]), normalized(block["generatedText"])), []).append(block)
    for (story, text), members in groups.items():
        if len(members) < 2: continue
        group_id = "repeat_" + sha((story + "\\0" + text).encode("utf-8"))[:16]; block_ids = [member["id"] for member in members]
        for member in members: member["source"]["reviewGroup"] = group_id; repeated.add(member["id"])
        diagnostics.append({"id":f"review-group-{group_id}","severity":"review_required","category":"repeated_headers_footers","message":f"{len(members)} repeated {story} item(s) are retained.","suggestedAction":"Keep them included or apply one exclusion rule to the shown group.","blockIds":block_ids,"groupId":group_id})
    for block in header_footer:
        if block["id"] in repeated: continue
        story = str(block["source"]["story"])
        diagnostics.append({"id":f"review-{story}-{block['id']}","severity":"review_required","category":"repeated_headers_footers","message":f"A {story} item is retained. Decide whether it belongs in the narration manuscript.","suggestedAction":"Keep it included or exclude this item.","blockIds":[block["id"]]})
    return diagnostics
def material_hash(value: Any) -> str: return sha(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode())
def approval_eligible(draft: dict[str, Any]) -> bool:
    decisions = draft.get("resolvedDiagnostics", {})
    return draft.get("state") == "ready" and not any(item.get("severity") == "review_required" and item.get("id") not in decisions for item in draft.get("diagnostics", []))
def diagnostic_by_id(draft: dict[str, Any], diagnostic_id: Any) -> dict[str, Any] | None:
    return next((item for item in draft.get("diagnostics", []) if item.get("id") == diagnostic_id), None)
def idempotent(draft: dict[str, Any], key: str, material: Any) -> Any | None:
    stored = draft.setdefault("idempotency", {}).get(key); fingerprint = material_hash(material)
    if stored and stored["fingerprint"] != fingerprint: raise RuntimeError("IDEMPOTENCY_KEY_REUSED")
    return stored.get("result") if stored else None
def remember(draft: dict[str, Any], key: str, material: Any, value: Any) -> None: draft.setdefault("idempotency", {})[key] = {"fingerprint":material_hash(material),"result":value}
def inspect(payload: dict[str, Any]) -> dict[str, Any]:
    source = payload["sourceRef"]; data = source_bytes(source)
    hint = str(source.get("formatHint", "")).lower()
    if hint == 'pdf':
        if not data.startswith(b'%PDF-') or not source.get('nativeText', '').strip(): raise RuntimeError('UNSUPPORTED_FORMAT')
        return {'format':'pdf','accessState':'readable','proposedRoute':'direct','mayExtract':True,'sizeBytes':len(data),'diagnostics':[]}
    if hint == 'docx' and str(source.get("displayName","")).lower().endswith('.docx'):
        blocks, diagnostics, counts = docx_extract(data)
        return {"format":"docx","accessState":"readable","proposedRoute":"direct","mayExtract":bool(blocks),"sizeBytes":len(data),"diagnostics":diagnostics + [{"id":"docx-adapter","severity":"information","category":"adapter","message":"DOCX direct extraction uses the local WordprocessingML adapter 1.0.0."}], **counts}
    if hint not in ("txt", "text") or not str(source.get("displayName","")).lower().endswith((".txt", ".text")): raise RuntimeError("UNSUPPORTED_FORMAT")
    text = decode_txt(data); normalized_text = normalized(text)
    return {"format":"txt","accessState":"readable","proposedRoute":"direct","mayExtract":True,"sizeBytes":len(data),"diagnostics":[{"id":"encoding","severity":"information","category":"text_encoding","message":"Text decoded locally and will be normalized to UTF-8 NFC/LF on approval."}],"paragraphCount":len([p for p in re.split(r'\n{2,}', normalized_text.strip()) if p])}
def extract(payload: dict[str, Any]) -> dict[str, Any]:
    root = root_for(payload); source = payload["sourceRef"]; draft_id = safe_id(payload.get("draftId"), "draft_"); key = str(payload.get("idempotencyKey") or "")
    if not key: raise ValueError("INVALID_REQUEST")
    target = draft_path(root, draft_id)
    if target.exists():
        existing = read_draft(root, draft_id); prior = idempotent(existing, key, {"operation":"extract","source":source})
        if prior is not None: return prior
        raise RuntimeError("APPROVAL_ALREADY_EXISTS")
    data = source_bytes(source); hint = str(source.get("formatHint", "")).lower()
    if hint == 'pdf':
        if not data.startswith(b'%PDF-') or not source.get('nativeText', '').strip(): raise RuntimeError('UNSUPPORTED_FORMAT')
        parts = [p for p in normalized(source['nativeText']).split('\n\n') if p.strip()]
        blocks = [{'id':f'block_{uuid.uuid4().hex}','position':i,'type':'paragraph','generatedText':p,'included':True} for i,p in enumerate(parts)]
        diagnostics = [{'id':'pdf-reading-order','severity':'review_required','category':'reading_order','message':'Review every PDF line against the source for headings, paragraph breaks, punctuation and reading order. No OCR or automatic dehyphenation was applied.'}]
        source_format = 'pdf'; adapter = {'name':'pdfjs-review-lines','version':'4.10.38'}
    elif hint == 'docx':
        blocks, diagnostics, counts = docx_extract(data)
        if not blocks: raise RuntimeError("EXTRACTION_FAILED")
        diagnostics += docx_review_diagnostics(blocks)
        diagnostics += [{"id":"docx-adapter","severity":"information","category":"adapter","message":"DOCX direct extraction used the local WordprocessingML adapter 1.0.0."}, {"id":"paragraphs","severity":"information","category":"paragraph_boundaries","message":f"{counts['paragraphCount']} DOCX paragraph boundaries were recovered."}]
        source_format = 'docx'; adapter = {"name":"wordprocessingml-stdlib","version":"1.0.0"}
    else:
        text = normalized(decode_txt(data)); parts = [part.strip('\n') for part in re.split(r'\n{2,}', text.strip('\n')) if part.strip('\n')]
        if not parts: raise RuntimeError("EXTRACTION_FAILED")
        blocks = [{"id":f"block_{uuid.uuid4().hex}","position":index,"type":"paragraph","generatedText":part,"included":True,"source":{"documentOrder":index,"paragraphIndex":index,"story":"body"}} for index, part in enumerate(parts)]
        diagnostics = [{"id":"encoding","severity":"information","category":"text_normalized","message":"Text was decoded locally; approval will use UTF-8, NFC, LF line endings, and one final newline."}, {"id":"paragraphs","severity":"information","category":"paragraph_boundaries","message":f"{len(blocks)} paragraph boundaries were preserved."}]
        source_format = 'txt'; adapter = {"name":"text-stdlib","version":"1.0.0"}
    draft = {"draftId":draft_id,"displayName":str(source.get("displayName") or "Text source"),"state":"ready","route":"direct","revision":1,"source":{"displayName":str(source.get("displayName") or "Text source"),"format":source_format,"sha256":str(source.get("expectedSha256")),"sizeBytes":int(source.get("sizeBytes") or 0)},"adapter":adapter,"sourcePath":str(source.get("canonicalPath")),"blocks":blocks,"diagnostics":diagnostics,"resolvedDiagnostics":{},"reviewOperations":[],"createdAt":now(),"idempotency":{}}
    target.parent.mkdir(parents=True, exist_ok=False); response={"draftId":draft_id,"revision":1,"state":"ready","route":"direct","blockCount":len(blocks),"diagnostics":diagnostics}
    remember(draft,key,{"operation":"extract","source":source},response); write_draft(root,draft); write_review_patch(root,draft); return response
def get_draft(payload: dict[str, Any]) -> dict[str, Any]:
    draft=read_draft(root_for(payload),safe_id(payload.get("draftId"),"draft_")); draft.pop("sourcePath",None); draft.pop("idempotency",None); return draft
def apply_change(payload: dict[str, Any]) -> dict[str, Any]:
    root=root_for(payload); draft=read_draft(root,safe_id(payload.get("draftId"),"draft_")); expected=payload.get("expectedRevision"); key=str(payload.get("idempotencyKey") or ""); operation=payload.get("operation")
    if not key or not isinstance(operation,dict): raise ValueError("INVALID_REQUEST")
    prior=idempotent(draft,key,{"operation":"review","expectedRevision":expected,"change":operation})
    if prior is not None: return prior
    if expected != draft["revision"]: raise RuntimeError("DRAFT_REVISION_CONFLICT")
    kind=operation.get("kind"); decisions=draft.setdefault("resolvedDiagnostics", {})
    if kind in ("replace_block_text", "restore_generated_text", "set_block_inclusion"):
        block=next((item for item in draft["blocks"] if item["id"] == operation.get("blockId")),None)
        if not block: raise RuntimeError("INVALID_REQUEST")
        if kind=="replace_block_text" and isinstance(operation.get("text"),str): block["replacementText"]=normalized(operation["text"])
        elif kind=="restore_generated_text": block.pop("replacementText",None)
        elif kind=="set_block_inclusion" and isinstance(operation.get("included"),bool):
            block["included"]=operation["included"]
            diagnostic_id=operation.get("diagnosticId"); diagnostic=diagnostic_by_id(draft,diagnostic_id)
            if diagnostic and block["id"] in diagnostic.get("blockIds", []): decisions[diagnostic_id] = operation.get("resolution") or ("keep_included" if operation["included"] else "exclude")
        else: raise RuntimeError("INVALID_REQUEST")
    elif kind=="resolve_diagnostic":
        diagnostic=diagnostic_by_id(draft,operation.get("diagnosticId")); resolution=operation.get("resolution")
        if not diagnostic or diagnostic.get("severity") != "review_required" or resolution not in ("keep_included", "exclude", "reviewed"): raise RuntimeError("INVALID_REQUEST")
        if resolution == "exclude":
            if diagnostic.get("groupId") or len(diagnostic.get("blockIds", [])) != 1: raise RuntimeError("INVALID_REQUEST")
            block=next((item for item in draft["blocks"] if item["id"] == diagnostic["blockIds"][0]),None)
            if not block: raise RuntimeError("INVALID_REQUEST")
            block["included"] = False
        decisions[diagnostic["id"]]=resolution
    elif kind=="apply_repetition_rule":
        group_id=operation.get("groupId"); diagnostic=diagnostic_by_id(draft,operation.get("diagnosticId")); members=[item for item in draft["blocks"] if item.get("source",{}).get("reviewGroup") == group_id]
        if not isinstance(group_id,str) or not isinstance(operation.get("included"),bool) or len(members)<2 or not diagnostic or diagnostic.get("groupId") != group_id: raise RuntimeError("INVALID_REQUEST")
        for member in members: member["included"]=operation["included"]
        decisions[diagnostic["id"]]=operation.get("resolution") or ("keep_included" if operation["included"] else "exclude")
    else: raise RuntimeError("INVALID_REQUEST")
    draft["reviewOperations"].append(operation); draft["revision"]+=1; response={"draftId":draft["draftId"],"revision":draft["revision"],"approvalEligible":approval_eligible(draft)}
    remember(draft,key,{"operation":"review","expectedRevision":expected,"change":operation},response); write_draft(root,draft); write_review_patch(root,draft); return response
def approve(payload: dict[str, Any]) -> dict[str, Any]:
    root=root_for(payload); draft=read_draft(root,safe_id(payload.get("draftId"),"draft_")); approved_id=safe_id(payload.get("approvedId"),"approved_"); key=str(payload.get("idempotencyKey") or ""); expected=payload.get("expectedRevision")
    if not key: raise ValueError("INVALID_REQUEST")
    prior=idempotent(draft,key,{"operation":"approve","expectedRevision":expected,"approvedId":approved_id})
    if prior is not None: return prior
    if expected != draft["revision"]: raise RuntimeError("DRAFT_REVISION_CONFLICT")
    if draft["state"] != "ready": raise RuntimeError("DRAFT_INCOMPLETE")
    if not approval_eligible(draft): raise RuntimeError("REVIEW_REQUIRED")
    source={"canonicalPath":draft["sourcePath"],"expectedSha256":draft["source"]["sha256"]}; source_bytes(source)
    content="\n\n".join(normalized(block.get("replacementText",block["generatedText"])) for block in draft["blocks"] if block["included"]).strip("\n")
    if not content: raise RuntimeError("REVIEW_REQUIRED")
    content=(content+"\n").encode("utf-8"); text_sha=sha(content); approved_root=root/"manuscript-prep"/"approved"; final=approved_root/approved_id
    if final.exists(): raise RuntimeError("APPROVAL_ALREADY_EXISTS")
    temporary=Path(tempfile.mkdtemp(prefix=f".{approved_id}-",dir=approved_root))
    try:
        manuscript=temporary/"manuscript.txt"; manuscript.write_bytes(content)
        unresolved_warnings=[item for item in draft["diagnostics"] if item.get("severity") != "review_required"]
        provenance={"schemaVersion":1,"original":{"filename":draft["source"]["displayName"],"format":draft["source"]["format"],"sizeBytes":draft["source"]["sizeBytes"],"sha256":draft["source"]["sha256"]},"extraction":{"method":"direct","toolVersion":"0.1.0","adapter":draft.get("adapter", {"name":"text-stdlib","version":"1.0.0"}),"passwordUsed":False},"warnings":draft["diagnostics"],"review":{"editCount":len(draft["reviewOperations"]),"editsOccurred":bool(draft["reviewOperations"]),"decisions":draft.get("resolvedDiagnostics",{}),"unresolvedNonBlockingWarnings":unresolved_warnings},"output":{"sha256":text_sha,"sizeBytes":len(content)},"approvedAt":now()}
        (temporary/"provenance.json").write_text(json.dumps(provenance,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
        if sha(manuscript.read_bytes()) != text_sha or manuscript.read_bytes().startswith(b'\xef\xbb\xbf'): raise RuntimeError("APPROVAL_FAILED")
        os.replace(temporary,final)
    except Exception:
        shutil.rmtree(temporary,ignore_errors=True); raise
    response={"approvedId":approved_id,"textSha256":text_sha,"sizeBytes":len(content),"approvedAt":provenance["approvedAt"],"sourceDisplayName":draft["source"]["displayName"],"route":"direct"}
    remember(draft,key,{"operation":"approve","expectedRevision":expected,"approvedId":approved_id},response); write_draft(root,draft); return response
def handle(request: dict[str, Any]) -> Any:
    if request.get("protocolVersion") != VERSION: raise RuntimeError("UNSUPPORTED_PROTOCOL_VERSION")
    payload=request.get("payload"); operation=request.get("operation")
    if not isinstance(payload,dict): raise ValueError("INVALID_REQUEST")
    return {"inspect":inspect,"extract":extract,"get_draft":get_draft,"apply_review_change":apply_change,"approve":approve,"cancel":lambda _: {"cancelled":False}}.get(operation,lambda _: (_ for _ in ()).throw(RuntimeError("INVALID_REQUEST")))(payload)
def main() -> None:
    emit({"kind":"hello","protocolVersion":VERSION,"worker":{"name":"manuscript-prep-worker","version":"0.1.0","capabilities":["inspect","extract","get_draft","apply_review_change","approve","cancel"]}})
    for line in sys.stdin:
        try:
            message=json.loads(line); request_id=str(message.get("requestId") or "")
            if not request_id: continue
            try: result(request_id,handle(message))
            except UnicodeDecodeError: result(request_id,err=error("SOURCE_UNREADABLE","The TXT source is not valid UTF-8 or UTF-16."))
            except FileNotFoundError: result(request_id,err=error("SOURCE_NOT_FOUND","The source file is no longer available.",True))
            except ValueError: result(request_id,err=error("INVALID_REQUEST","The request was invalid."))
            except RuntimeError as exc:
                code=str(exc); result(request_id,err=error(code, {"SOURCE_CHANGED":"The source changed since inspection.","UNSUPPORTED_FORMAT":"Only TXT and DOCX sources are supported.","INPUT_LIMIT_EXCEEDED":"The source exceeds the input size limit.","REVIEW_REQUIRED":"Required DOCX review decisions are still outstanding."}.get(code,"Manuscript Prep could not complete this operation."),code in {"SOURCE_CHANGED","DRAFT_REVISION_CONFLICT"}))
            except Exception: result(request_id,err=error("INTERNAL_ERROR","Manuscript Prep encountered an unexpected local error.",True))
        except Exception: continue
if __name__ == "__main__": main()
