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
            os.environ["RAG_DATA_DIR"] = directory
            try:
                import app

                self.assertEqual(app.DATA_DIR, Path(directory).resolve())
                with TestClient(app.app) as client:
                    self.exercise(client)
            finally:
                if previous is None:
                    os.environ.pop("RAG_DATA_DIR", None)
                else:
                    os.environ["RAG_DATA_DIR"] = previous

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
        from question_router import QuestionPlan

        completion = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="对比结果"))],
            usage=SimpleNamespace(total_tokens=12),
        )

        def ask(question, route, *, scope=None, folders=(), names=(), count=False, stream=False):
            payload = {"question": question, **(scope or {})}
            plan = QuestionPlan(route=route, folder_names=list(folders), document_names=list(names), count_only=count)
            with patch("app.get_deepseek_client") as factory, patch("app.plan_question", return_value=(plan, 5)):
                create = factory.return_value.chat.completions.create
                create.return_value = completion
                response = client.post("/api/chat" + ("?stream=true" if stream else ""), json=payload)
                self.assertEqual(response.status_code, 200, response.text)
                if stream:
                    return [json.loads(line) for line in response.iter_lines()], create
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
        self.assertIn("2/2", report["answer"])
        self.assertEqual({source["id"] for source in report["sources"]}, {aurora, northwind})
        context = create.call_args.kwargs["messages"][-1]["content"]
        self.assertIn("37 hours", context)
        self.assertIn("23 hours", context)
        single, _ = ask("总结Aurora Protocol.pdf文献", "overview", names=["Aurora Protocol.pdf"])
        self.assertIn("1/1", single["answer"])
        self.assertEqual({source["id"] for source in single["sources"]}, {aurora})
        general, create = ask("什么是向量数据库？", "general")
        self.assertIn("通用回答", general["answer"])
        create.assert_called_once()

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

        replacement = make_pdf("Aurora Protocol revised battery duration to 41 hours.")
        response = client.post(f"/api/documents/{aurora}/versions", files={"file": ("revision.pdf", replacement)})
        checked(response, 202)
        wait_for({aurora})
        checked(client.post("/api/knowledge/read", json={"chunk_id": chunk_id}), 404)
        hits = post("search", {"query": "battery duration", "document_ids": [aurora]})["candidates"]
        self.assertEqual(len(hits), 1)
        evidence = post("read", {"chunk_id": hits[0]["chunk_id"]})["evidence"][0]
        self.assertIn("41 hours", evidence["excerpt"])
        response = client.get(f"/api/documents/{aurora}/file", params={"version_id": hashlib.sha256(original).hexdigest()})
        self.assertEqual(response.content, original)
