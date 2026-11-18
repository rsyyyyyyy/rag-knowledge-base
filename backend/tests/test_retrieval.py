"""Run from backend with the project interpreter: python -m unittest discover -s tests -p test_retrieval.py."""

import hashlib
import io
import json
import os
import tempfile
from pathlib import Path
from time import monotonic, sleep
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from fastapi.testclient import TestClient
from PyPDF2 import PdfWriter
from PyPDF2.generic import DecodedStreamObject, DictionaryObject, NameObject


def make_pdf(*lines):
    writer = PdfWriter()
    for line in lines:
        writer.add_blank_page(540, 700)
        page = writer.pages[-1]
        font = DictionaryObject({
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        })
        page[NameObject("/Resources")] = DictionaryObject({
            NameObject("/Font"): DictionaryObject({NameObject("/F1"): font}),
        })
        content = DecodedStreamObject()
        content.set_data(f"BT /F1 12 Tf 70 560 Td ({line}) Tj ET".encode("ascii"))
        page[NameObject("/Contents")] = writer._add_object(content)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


class RetrievalIntegrationTest(TestCase):
    def test_retrieval_and_evidence(self):
        with tempfile.TemporaryDirectory(prefix="rag-retrieval-", ignore_cleanup_errors=True) as directory:
            previous = os.environ.get("RAG_DATA_DIR")
            previous_auto_metadata = os.environ.get("RAG_AUTO_METADATA")
            previous_auto_profile = os.environ.get("RAG_AUTO_PROFILE")
            os.environ["RAG_DATA_DIR"] = directory
            os.environ["RAG_AUTO_METADATA"] = "0"
            os.environ["RAG_AUTO_PROFILE"] = "0"
            try:
                import app

                self.assertEqual(app.DATA_DIR, Path(directory).resolve())
                # Model calls are mocked below; discovery must also be independent
                # of API keys and locally running Ollama instances.
                configured_model = SimpleNamespace(model=app.DEEPSEEK_MODEL, label="Test model",
                                                   provider="deepseek", extra_body=None)
                with TestClient(app.app) as client, patch("app.resolve_model", return_value=configured_model):
                    self.exercise(client)
            finally:
                if previous_auto_profile is None:
                    os.environ.pop("RAG_AUTO_PROFILE", None)
                else:
                    os.environ["RAG_AUTO_PROFILE"] = previous_auto_profile
                if previous is None:
                    os.environ.pop("RAG_DATA_DIR", None)
                else:
                    os.environ["RAG_DATA_DIR"] = previous
                if previous_auto_metadata is None:
                    os.environ.pop("RAG_AUTO_METADATA", None)
                else:
                    os.environ["RAG_AUTO_METADATA"] = previous_auto_metadata

    def exercise(self, client):
        def checked(response, status=200):
            self.assertEqual(response.status_code, status, response.text)
            return response.json()

        def post(path, payload):
            return checked(client.post("/api/knowledge/" + path, json=payload))

        def folder(title):
            return checked(client.post("/api/folders", params={"name": title}))["folder"]["id"]

        def upload(filename, content, folder_id):
            response = client.post("/api/documents/upload", data={"folder_id": folder_id},
                                   files={"file": (filename, content)})
            return checked(response, 202)["document_id"]

        def wait_for(ids):
            deadline = monotonic() + 45
            while monotonic() < deadline:
                documents = checked(client.get("/api/documents"))["documents"]
                statuses = {doc["id"]: doc["metadata"]["status"] for doc in documents if doc["id"] in ids}
                if all(status == "parsed" for status in statuses.values()) and len(statuses) == len(ids):
                    return
                self.assertTrue(set(statuses.values()) <= {"queued", "processing", "parsed"}, statuses)
                sleep(0.1)
            self.fail(f"Index did not publish: {statuses}")

        energy = folder("Energy")
        methods = folder("Methods")
        original = make_pdf(
            "Aurora Protocol defines a controlled battery experiment at 25 degrees.",
            "PX-914 is the Aurora Protocol test identifier. Battery duration was exactly 37 hours.",
        )
        aurora = upload("Aurora Protocol.pdf", original, energy)
        northwind = upload("Northwind Study.txt", b"Northwind Study reports battery duration of 23 hours.", energy)
        density = upload("非参数聚类.txt", "采用 DBSCAN 按局部样本密度形成簇，离群样本标记为噪声，无需预设簇数。".encode(), methods)
        chinese = upload("地震波拾取.txt", "我们用短时长时平均比 STA/LTA 检测地震初至波，相对幅值阈值为三。".encode(), methods)
        doi_only = upload("Resistance validation.txt", b"The fixture recorded an electrical resistance of 5 ohms.", methods)
        checked(client.put("/api/documents/" + doi_only + "/metadata", params={
            "title": "Violet Resistance Benchmark", "doi": "10.5555/violet-qx27",
        }))
        distractors = [
            "PX-913 measurement uses the same setup and reports battery duration of 36 hours.",
            "PX-915 identifier belongs to an experiment on batteries at elevated temperatures.",
            "Long battery life depends on charging rates and cell chemistry in the Aurora lab.",
            "Measuring duration requires controlling the room temperature during the experiment.",
            "We compare storage lifetimes in three portable battery systems.",
            "Data clustering groups records; k-means requires specifying the number of groups.",
            "监督式分类方法使用带标签的训练样本预测类别。",
            "地震记录的强振幅与震源深度、介质和传播距离有关。",
            "电阻与导体长度成正比，电阻率由材料及温度决定。",
            "Optical resistance study compares glass substrates with UV filter coatings.",
            "Benchmark reporting documents use controlled temperature and test identifiers.",
        ]
        controls = [upload(f"control-{i}.txt", text.encode(), energy if i < 5 else methods)
                    for i, text in enumerate(distractors)]
        wait_for({aurora, northwind, density, chinese, doi_only, *controls})
        structure = checked(client.get(f"/api/documents/{aurora}/sections"))
        self.assertEqual(checked(client.get(f"/api/documents/{aurora}/profile"))["state"], "not_generated")
        checked(client.get(f"/api/documents/{aurora}/profile?version_id=retired"), 409)
        self.assertTrue(structure["sections"])
        section_id = structure["sections"][0]["id"]
        payload = {
            "document_id": aurora, "section_id": section_id,
            "version_id": structure["version_id"], "generation": structure["generation"],
        }
        section = checked(client.post("/api/knowledge/read-section", json=payload))
        self.assertTrue(section["evidence"])
        self.assertEqual(section["evidence"][0]["id"], aurora)
        self.assertEqual(section["evidence"][0]["section_id"], section_id)
        checked(client.post("/api/knowledge/read-section", json={**payload, "document_ids": [northwind]}), 404)
        checked(client.post("/api/knowledge/read-section", json={**payload, "generation": "outdated"}), 409)
        from question_router import QuestionPlan

        completion = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="对比结果"))],
            usage=SimpleNamespace(total_tokens=12),
        )

        def ask(question, route, *, scope=None, folders=(), names=(), count=False, stream=False, reference="explicit", indices=()):
            payload = {"question": question, **(scope or {})}
            plan = QuestionPlan(route=route, folder_names=list(folders), document_names=list(names), count_only=count,
                                reference_mode=reference, reference_indices=list(indices))
            # Scope/routing assertions are independent of the semantic evidence verifier.
            with patch("app.get_deepseek_client") as factory, patch("app.plan_question", return_value=(plan, 5)), patch(
                "app.ground_answer", side_effect=lambda answer, sources, *args: (answer, sources, 0, {})
            ):
                create = factory.return_value.chat.completions.create
                create.return_value = completion
                response = client.post("/api/chat" + ("?stream=true" if stream else ""), json=payload)
                self.assertEqual(response.status_code, 200, response.text)
                if stream:
                    events = [json.loads(line) for line in response.iter_lines()]
                    self.assertEqual(events[0]["type"], "heartbeat")
                    return [event for event in events if event["type"] != "heartbeat"], create
                return response.json(), create

        listing, create = ask("我放在 Energy 那一栏的材料给我盘点一遍", "documents", folders=["Energy"])
        self.assertEqual(listing["model_used"], "local-catalog")
        self.assertEqual(listing["route"], "documents")
        self.assertEqual(listing["token_usage"], 5)
        self.assertIn("Aurora Protocol.pdf", listing["answer"])
        self.assertIn("Northwind Study.txt", listing["answer"])
        self.assertNotIn("Resistance validation", listing["answer"])
        self.assertEqual(listing["sources"], [])
        create.assert_not_called()
        frames, _ = ask("Energy文件夹下有哪些文献", "documents", folders=["Energy"], stream=True)
        self.assertEqual([frame["type"] for frame in frames], ["text", "end"])
        self.assertEqual(frames[1]["route"], "documents")

        outside, _ = ask("Energy文件夹下有哪些文献", "documents", folders=["Energy"],
                         scope={"folder_ids": [methods]})
        self.assertIn("没有找到", outside["answer"])
        folder("Empty")
        empty, _ = ask("请列出 empty 文件夹里的文献", "documents", folders=["empty"])
        self.assertIn("目前没有", empty["answer"])
        folder("默认")
        default_id = folder("默认文件夹")
        root_doc = upload("default-folder-entry.txt", b"Fixture reserved for exact folder name resolution.", default_id)
        wait_for({root_doc})
        exact, _ = ask("知识库中的默认文件夹有哪些文件", "documents", folders=["默认文件夹"])
        self.assertIn("default-folder-entry.txt", exact["answer"])
        count, _ = ask("默认文件夹有几篇文献", "documents", folders=["默认文件夹"], count=True)
        self.assertIn("**1**", count["answer"])
        self.assertNotIn("default-folder-entry.txt", count["answer"])

        catalog, _ = ask("我的资料是分成哪几栏管理的？", "folders")
        self.assertEqual(catalog["model_used"], "local-catalog")
        self.assertIn("Energy", catalog["answer"])
        self.assertIn("默认文件夹", catalog["answer"])
        exists, _ = ask("Aurora Protocol.pdf这个文献，是删除了吗？", "file_status", names=["Aurora Protocol.pdf"])
        self.assertIn("Aurora Protocol.pdf · Energy · 可检索", exists["answer"])
        missing, _ = ask("能否找一下 missing.pdf", "file_status", names=["missing.pdf"])
        self.assertIn("没有找到文献", missing["answer"])
        no_sources, _ = ask("给我讲讲这一批文献总体在研究什么", "overview", scope={"document_ids": []})
        self.assertIn("没有可用于综述", no_sources["answer"])

        report, create = ask("总结一下知识库中的所有文献", "overview",
                             scope={"document_ids": [aurora, northwind]})
        self.assertEqual(report["reading"]["documents"], 2)
        self.assertNotIn("个正文片段", report["answer"])
        self.assertNotIn("长文已分批", report["answer"])
        self.assertEqual({source["id"] for source in report["sources"]}, {aurora, northwind})
        context = create.call_args.kwargs["messages"][-1]["content"]
        self.assertIn("37 hours", context)
        self.assertIn("23 hours", context)
        single, _ = ask("总结Aurora Protocol.pdf文献", "overview", names=["Aurora Protocol.pdf"])
        self.assertEqual(single["reading"]["documents"], 1)
        self.assertEqual({source["id"] for source in single["sources"]}, {aurora})
        full, create = ask("这篇实验的最终结果是什么？", "evidence",
                           scope={"document_ids": [aurora], "top_k": 1})
        self.assertEqual(full["reading"]["chunks_total"], 2)
        self.assertEqual(full["reading"]["chunks_read"], 2)
        self.assertIn("37 hours", create.call_args.kwargs["messages"][-1]["content"])
        # Real grounding pipeline: neighboring original passages, quote offsets,
        # canonical numbering and narrowed PDF boxes survive the HTTP response.
        from types import SimpleNamespace as NS
        answer_text = "Battery duration was exactly 37 hours. [2](#evidence-2)"
        def reply(content):
            return NS(choices=[NS(message=NS(content=content), finish_reason="stop")], usage=NS(total_tokens=12))
        with patch("app.get_deepseek_client") as factory, patch("app.plan_question", return_value=(
            QuestionPlan(route="overview"), 5,
        )):
            factory.return_value.__enter__.return_value = factory.return_value
            factory.return_value.chat.completions.create.side_effect = [
                reply(answer_text), reply(json.dumps({"checks":[{"ref":"0","supported":True,
                    "claim":"Battery duration was exactly 37 hours.", "passage":2,
                    "quote":"Battery duration was exactly 37 hours."}]})),
            ]
            grounded = checked(client.post('/api/chat', json={"question":"Explain duration", "document_ids":[aurora]}))
        self.assertIn('[1](#evidence-1)', grounded['answer'])
        self.assertEqual(len(grounded['sources']), 1)
        self.assertEqual(grounded['sources'][0]['page_index'], 1)
        self.assertEqual(grounded['sources'][0]['excerpt'], 'Battery duration was exactly 37 hours.')
        self.assertTrue(grounded['sources'][0]['span_id'])
        self.assertTrue(grounded['sources'][0]['element_refs'])
        self.assertEqual(grounded['sources'][0]['citation_precision'], 'quote')
        self.assertEqual(grounded['token_usage'], 29)
        class FakeStream:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def __iter__(self):
                yield SimpleNamespace(usage=None, choices=[SimpleNamespace(
                    delta=SimpleNamespace(content="实验结果为37小时 [2](#evidence-2)"))])
                yield SimpleNamespace(usage=SimpleNamespace(total_tokens=12), choices=[])

        with patch("app.get_deepseek_client") as factory, patch("app.plan_question", return_value=(
            QuestionPlan(route="overview"), 5,
        )), patch("app.ground_answer", side_effect=lambda answer, sources, *args: (answer, sources, 0, {})):
            factory.return_value.chat.completions.create.return_value = FakeStream()
            response = client.post("/api/chat?stream=true", json={
                "question": "完整介绍这篇", "document_ids": [aurora],
            })
            self.assertEqual(response.status_code, 200, response.text)
            frames = [json.loads(line) for line in response.iter_lines()]
            self.assertEqual(frames[-1]["reading"]["chunks_read"], 2)
            self.assertEqual(frames[-1]["token_usage"], 17)
            self.assertEqual(frames[-2]["type"], "sources")
            self.assertTrue(frames[-2]["sources"][-1]["rects"])
        # More than the previous eight-document cap: every active paper is read.
        all_docs, _ = ask("完整概括所有文献", "overview")
        self.assertEqual(all_docs["reading"]["documents"], 17)
        self.assertEqual(len({s["id"] for s in all_docs["sources"]}), 17)
        general, create = ask("什么是向量数据库？", "general")
        self.assertIn("通用回答", general["answer"])
        create.assert_called_once()

        thread_id = checked(client.post("/api/chat/threads"), 201)["id"]
        base_scope = {"thread_id": thread_id, "document_ids": [aurora, northwind, density]}
        shown, _ = ask("列出这三篇", "documents", scope=base_scope)
        self.assertIn("Aurora Protocol.pdf", shown["answer"])
        selected, _ = ask("Aurora Protocol.pdf", "file_status", scope={"thread_id": thread_id},
                           names=["Aurora Protocol.pdf"])
        self.assertIn("你想如何阅读", selected["answer"])
        still_there, _ = ask("刚才提到的文献还在吗", "file_status",
                             scope={"thread_id": thread_id}, reference="focus",
                             names=["invented-history-filename.pdf"])
        self.assertIn("Aurora Protocol.pdf", still_there["answer"])
        self.assertNotIn("没有找到", still_there["answer"])
        others, _ = ask("除了这个文献另外两篇呢", "file_status",
                        scope={"thread_id": thread_id}, reference="others")
        self.assertIn("Northwind Study.txt", others["answer"])
        self.assertIn("非参数聚类.txt", others["answer"])
        self.assertNotIn("Aurora Protocol.pdf", others["answer"])
        unknown, _ = ask("does-not-exist.pdf", "file_status",
                         scope={"thread_id": thread_id}, names=["does-not-exist.pdf"])
        self.assertIn("没有找到", unknown["answer"])
        focused, _ = ask("介绍一下它们", "overview", scope={"thread_id": thread_id}, reference="focus")
        self.assertEqual({source["id"] for source in focused["sources"]}, {northwind, density})
        self.assertEqual(focused["reading"]["documents"], 2)
        new_thread = checked(client.post("/api/chat/threads"), 201)["id"]
        isolated, _ = ask("刚才那篇还在吗", "file_status",
                          scope={"thread_id": new_thread}, reference="focus")
        self.assertIn("请明确", isolated["answer"])
        managed = checked(client.post('/api/chat/threads'), 201)['id']
        renamed = checked(client.patch('/api/chat/threads/' + managed, json={'title': '  专题   阅读  '}))
        self.assertEqual(renamed['title'], '专题 阅读')
        self.assertIn(renamed['id'], [t['id'] for t in checked(client.get('/api/chat/threads'))['threads']])
        checked(client.patch('/api/chat/threads/' + managed, json={'title': '   '}), 422)
        checked(client.patch('/api/chat/threads/' + managed, json={'title': '字' * 101}), 422)
        self.assertEqual(client.delete('/api/chat/threads/' + managed).status_code, 204)
        checked(client.get('/api/chat/threads/' + managed), 404)
        checked(client.patch('/api/chat/threads/' + managed, json={'title': '不存在'}), 404)
        checked(client.delete('/api/chat/threads/' + managed), 404)
        self.assertTrue(checked(client.get('/api/documents'))['documents'])

        cases = [
            ("identifier", "PX-914", {aurora}),
            ("title", "Violet Resistance Benchmark", {doi_only}),
            ("doi", "10.5555/violet-qx27", {doi_only}),
            ("Chinese acronym", "STA/LTA 初至波的阈值", {chinese}),
            ("paraphrase", "不用给出类别数量，如何把异常样本单独标出来？", {density}),
            ("comparison", "Compare battery duration for Aurora Protocol and Northwind Study", {aurora, northwind}),
        ]
        for label, question, expected in cases:
            ranks = {}
            for mode in ("vector", "hybrid"):
                hits = post("search", {"query": question, "top_k": 8, "retrieval_mode": mode})["candidates"]
                self.assertNotIn("evidence_id", hits[0])
                ranks[mode] = {
                    doc_id: next((rank for rank, hit in enumerate(hits, 1) if hit["document_id"] == doc_id), None)
                    for doc_id in expected
                }
            print(f"{label}: vector={sorted(ranks['vector'].values(), key=lambda r: r or 99)} "
                  f"hybrid={sorted(ranks['hybrid'].values(), key=lambda r: r or 99)}")
            self.assertTrue(all(rank is not None for rank in ranks["hybrid"].values()), label)

        for mode in ("vector", "hybrid"):
            self.assertEqual(post("search", {"query": "PX-914", "folder_ids": [], "retrieval_mode": mode})["candidates"], [])
            hits = post("search", {"query": "PX-914", "folder_ids": [methods], "retrieval_mode": mode})["candidates"]
            self.assertTrue(hits)
            self.assertNotIn(aurora, [hit["document_id"] for hit in hits])
            self.assertEqual(post("search", {"query": "PX-914", "document_ids": [aurora],
                                            "folder_ids": [methods], "retrieval_mode": mode})["candidates"], [])
        self.assertEqual(post("list", {"document_ids": [aurora, density], "folder_ids": [energy]})["total"], 1)
        with patch.dict(os.environ, {'DEEPSEEK_API_KEY': ''}):
            papers = post('search-papers', {'query': 'PX-914', 'folder_ids': [energy]})['papers']
        self.assertEqual(papers[0]['document_id'], aurora)
        self.assertTrue(papers[0]['body_previews'][0]['source']['chunk_id'])
        self.assertEqual(post('search-papers', {'query': 'PX-914', 'document_ids': []})['papers'], [])

        hits = post("search", {"query": "PX-914", "document_ids": [aurora]})["candidates"]
        candidate = next(hit for hit in hits if hit["page_index"] == 1)
        self.assertEqual(candidate["rank_signals"]["lexical"], 1)
        chunk_id = candidate["chunk_id"]
        for payload in ({"chunk_id": chunk_id, "folder_ids": [methods]}, {"chunk_id": "invented"}):
            checked(client.post("/api/knowledge/read", json=payload), 404)
        evidence = post("read", {"chunk_id": chunk_id, "adjacent": 1, "folder_ids": [energy]})["evidence"]
        self.assertEqual([source["page_index"] for source in evidence], [0, 1])
        self.assertEqual([source["evidence_id"] for source in evidence], ["E1", "E2"])
        self.assertEqual(evidence[1]["version_id"], hashlib.sha256(original).hexdigest())
        self.assertTrue(evidence[1]["rects"])

        from question_router import EvidenceAspect
        from literature_tools import LiteratureTools

        def coverage_review(**kwargs):
            payload = json.loads(kwargs['messages'][-1]['content'])
            rows = []
            for item in payload['items']:
                eligible = [s for s in payload['passages'] if s['number'] in item['allowed_passages']]
                row = {'id': item['id'], 'coverage': 'missing', 'facts': [], 'search_query': 'battery duration'}
                expected = 37 if item['document_id'] == aurora else 23
                source = next((s for s in eligible if f'{expected} hours' in s['text']), None)
                if source:
                    quote = source['text']
                    row.update(coverage='full', facts=[{'text': f'电池持续 {expected} 小时。',
                                                        'passage': source['number'], 'quote': quote}])
                rows.append(row)
            return reply(json.dumps({'items': rows}, ensure_ascii=False))

        targeted_calls = []
        read_for_coverage = LiteratureTools.read_for_coverage

        def record_target(registry, query, document_id):
            targeted_calls.append(document_id)
            return read_for_coverage(registry, query, document_id)

        with patch.dict(os.environ, {'RAG_LITERATURE_TOOLS': '1'}), patch('app.get_deepseek_client') as factory, patch(
            'app.plan_question', return_value=(QuestionPlan(route='evidence', reading_mode='local', compare_papers=True,
                evidence_aspects=[EvidenceAspect(label='Aurora Protocol 的电池时长', query='battery duration'),
                                  EvidenceAspect(label='Northwind Study 的电池时长', query='battery duration')]), 5),
        ), patch('app.collect_tool_evidence', return_value=([evidence[1]], 3, 'selected')), patch.object(
            LiteratureTools, 'read_for_coverage', record_target,
        ):
            factory.return_value.__enter__.return_value = factory.return_value
            factory.return_value.chat.completions.create.side_effect = coverage_review
            response = client.post('/api/chat?stream=true', json={
                'question': '比较两篇的电池时长', 'document_ids': [aurora, northwind],
            })
            self.assertEqual(response.status_code, 200, response.text)
            frames = [json.loads(line) for line in response.iter_lines()]
            self.assertEqual([frame['type'] for frame in frames], ['heartbeat', 'text', 'sources', 'end'])
            self.assertIn('37 小时', frames[1]['content'])
            self.assertIn('23 小时', frames[1]['content'])
            self.assertEqual({s['id'] for s in frames[2]['sources']}, {aurora, northwind})
            self.assertEqual(targeted_calls, [northwind])
            self.assertEqual([item['status'] for item in frames[-1]['diagnostics']['coverage']['items']], ['full', 'full'])

        import app
        from knowledge_search import KnowledgeScope
        from openai.types.chat import ChatCompletionMessageFunctionToolCall

        def tool_reply(*calls):
            return SimpleNamespace(usage=SimpleNamespace(total_tokens=12), choices=[SimpleNamespace(
                finish_reason='tool_calls', message=SimpleNamespace(content=None, tool_calls=[
                    ChatCompletionMessageFunctionToolCall(id=f'call_{index}', type='function',
                        function={'name': name, 'arguments': json.dumps(args)})
                    for index, (name, args) in enumerate(calls)
                ]))])

        pinned = LiteratureTools(app.knowledge_search, app.document_profiles, KnowledgeScope(document_ids=[aurora]))
        self.assertEqual(pinned.execute('read_passages', json.dumps({'chunk_ids': [chunk_id]}))['status'], 'ok')
        self.assertEqual(pinned.execute('search_papers', '{"query":"test","document_ids":[]}')['code'], 'invalid_arguments')
        self.assertEqual(pinned.execute('unknown_function', '{}')['code'], 'unknown_tool')
        self.assertEqual(pinned.execute('read_passages', json.dumps({'chunk_ids': [chunk_id]}))['code'], 'duplicate_call')
        with patch.dict(os.environ, {'RAG_LITERATURE_TOOLS': '1'}), patch('app.get_deepseek_client') as factory, patch(
            'app.plan_question', return_value=(QuestionPlan(route='evidence', reading_mode='local'), 5),
        ), patch('app.ground_answer', side_effect=lambda answer, sources, *args: (answer, sources, 0, {})):
            factory.return_value.__enter__.return_value = factory.return_value
            create = factory.return_value.chat.completions.create
            create.side_effect = [tool_reply(('list_sections', {'document_id': northwind}),
                                            ('search_passages', {'query': 'PX-914', 'document_id': aurora})),
                                  tool_reply(('read_passages', {'chunk_ids': [chunk_id]})),
                                  reply(json.dumps({'chunk_ids': ['not-read', chunk_id]})),
                                  reply('实验结果为37小时 [1](#evidence-1)')]
            result = checked(client.post('/api/chat', json={'question': 'PX-914 的持续时长？', 'document_ids': [aurora]}))
            tools = result['diagnostics']['tools']
            self.assertEqual(tools['stop'], 'selected')
            self.assertFalse(tools['fallback'])
            self.assertIn('not_in_scope', [call.get('code') for call in tools['calls']])
            self.assertEqual([source['chunk_id'] for source in result['sources']], [chunk_id])
            self.assertEqual(result['token_usage'], 53)
            self.assertIn('citation_verification', result['diagnostics']['stages_ms'])
            self.assertEqual(create.call_args_list[0].kwargs['tool_choice'], 'required')
            self.assertTrue(any(m['role'] == 'tool' for m in create.call_args_list[1].kwargs['messages']))

        with patch.dict(os.environ, {'RAG_LITERATURE_TOOLS': '1'}), patch('app.get_deepseek_client') as factory, patch(
            'app.plan_question', return_value=(QuestionPlan(route='evidence', reading_mode='local'), 5),
        ), patch('app.select_rag_evidence', return_value=([], 4)) as fallback:
            factory.return_value.__enter__.return_value = factory.return_value
            factory.return_value.chat.completions.create.return_value = reply('invalid selection')
            response = client.post('/api/chat?stream=true', json={'question': '局部结果？', 'document_ids': [aurora]})
            self.assertEqual(response.status_code, 200, response.text)
            final = [json.loads(line) for line in response.iter_lines()][-1]
            self.assertTrue(final['diagnostics']['tools']['fallback'])
            self.assertIn('passage_retrieval', final['diagnostics']['stages_ms'])
            self.assertEqual(final['token_usage'], 21)
            fallback.assert_called_once()

        replacement = make_pdf("Aurora Protocol revised battery duration to 41 hours.")
        response = client.post(f"/api/documents/{aurora}/versions", files={"file": ("revision.pdf", replacement)})
        checked(response, 202)
        wait_for({aurora})
        self.assertEqual(pinned.sources(), [])
        self.assertEqual(pinned.execute('list_sections', json.dumps({'document_id': aurora}))['code'], 'stale_version')
        checked(client.post("/api/knowledge/read", json={"chunk_id": chunk_id}), 404)
        hits = post("search", {"query": "battery duration", "document_ids": [aurora]})["candidates"]
        self.assertEqual(len(hits), 1)
        evidence = post("read", {"chunk_id": hits[0]["chunk_id"]})["evidence"][0]
        self.assertIn("41 hours", evidence["excerpt"])
        response = client.get(f"/api/documents/{aurora}/file", params={"version_id": hashlib.sha256(original).hexdigest()})
        self.assertEqual(response.content, original)
