from catalog_questions import normalized
from knowledge_search import KnowledgeScope


def reference(entry, active):
    return {"id": entry["id"], "filename": entry["filename"],
            "version_id": active.get(entry["id"], (None, None))[1]}


def catalog_snapshot(service, scope, state):
    documents = service._documents(scope)
    active = service._active(documents)
    return {
        "working_state": state,
        "available_documents": [
            {"id": key, "filename": doc.get("filename"), "title": doc.get("title"),
             "folder_id": doc.get("folder_id"), "searchable": key in active}
            for key, doc in list(documents.items())[:100]
        ],
        "catalog_truncated": len(documents) > 100,
        "folders": [{"id": f["id"], "name": f["name"], "parent_id": f.get("parent_id")}
                    for f in service.catalog.load("folders")
                    if scope.folder_ids is None or f["id"] in scope.folder_ids][:100],
    }


def resolve_reference(plan, scope, state):
    group = state.get("group", [])
    mode = plan.reference_mode
    if mode == "explicit":
        return scope, None, []
    if mode == "focus":
        chosen = state.get("focus", [])
    elif mode == "group":
        chosen = group
    elif mode == "others":
        excluded = {item["id"] for item in state.get("focus", [])}
        chosen = [item for item in group if item["id"] not in excluded]
    else:
        if not plan.reference_indices or any(index < 1 or index > len(group) for index in plan.reference_indices):
            return scope, "请指出要讨论的文献，当前清单中没有这个序号。", []
        chosen = [group[index - 1] for index in dict.fromkeys(plan.reference_indices)]
    if not chosen:
        return scope, "请明确要讨论的文献，或先列出一组文献。", []
    allowed = set(scope.document_ids) if scope.document_ids is not None else None
    ids = [item["id"] for item in chosen if allowed is None or item["id"] in allowed]
    if len(ids) != len(chosen):
        return scope, "所指文献不在本次选定范围内，请调整范围或重新指定。", []
    return KnowledgeScope(document_ids=ids, folder_ids=scope.folder_ids), None, chosen


def update_working_state(state, scope, service, *, listing=None, preserve_group=False):
    documents = service._documents(scope)
    active = service._active(documents)
    if listing is not None:
        state["group"] = [reference(item, active) for item in listing["documents"]]
        state["focus"] = state["group"] if len(state["group"]) == 1 else []
        return
    if scope.document_ids is None:
        return
    selected = [
        {"id": key, "filename": documents[key].get("filename"), "version_id": active.get(key, (None, None))[1]}
        for key in scope.document_ids if key in documents
    ]
    if selected:
        state["focus"] = selected
        if len(selected) > 1 and not preserve_group:
            state["group"] = selected


def bare_document(question, service, scope):
    key = normalized(question)
    return [doc_id for doc_id, metadata in service._documents(scope).items()
            if key and key in {normalized(metadata.get("filename") or ""),
                               normalized(metadata.get("title") or "")}]


def recover_working_state(turns, service):
    """Reconstruct older thread entities only from persisted records and verified IDs."""
    state = {}
    all_documents = service._documents(KnowledgeScope())
    for turn in turns:
        scope = turn.get("scope") or {}
        if turn.get("route") == "documents":
            entries = []
            for line in turn["answer"].splitlines():
                if not line.startswith("- "):
                    continue
                label = line[2:]
                matches = [key for key, doc in all_documents.items()
                           if label == doc.get("filename") or label.startswith((doc.get("filename") or "") + "（")]
                if len(matches) != 1:
                    entries = []
                    break
                entries.append({"id": matches[0], "filename": all_documents[matches[0]]["filename"],
                                "version_id": None})
            if entries:
                state.update(group=entries, focus=entries if len(entries) == 1 else [])
        verified = [
            {"id": source["id"], "filename": source["filename"],
             "version_id": source.get("version_id") or source.get("document_version_id")}
            for source in turn.get("sources", []) if source.get("id") != "attachment"
        ]
        ordered = {item["id"]: item for item in verified}
        selected = [key for key in (scope.get("document_ids") or []) if key in all_documents]
        # A failed filename lookup may have a scope but carries no verified source.
        if ordered:
            entries = [ordered[key] for key in selected if key in ordered] or list(ordered.values())
            state["focus"] = entries
            if len(entries) > 1:
                state["group"] = entries
        elif turn.get("route") == "file_status" and "查到以下文件记录" in turn["answer"] and selected:
            state["focus"] = [
                {"id": key, "filename": all_documents[key]["filename"], "version_id": None}
                for key in selected
            ]
    return state
