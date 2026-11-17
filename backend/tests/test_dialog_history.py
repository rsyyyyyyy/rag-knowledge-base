import tempfile
from pathlib import Path
from unittest import TestCase

from catalog import Catalog
from chat_history import ChatHistory


class DialogHistoryTest(TestCase):
    def test_rename_persists_and_delete_clears_only_selected_thread(self):
        with tempfile.TemporaryDirectory() as root:
            catalog = Catalog(Path(root))
            history = ChatHistory(catalog)
            thread, other = history.create(), history.create()
            self.assertTrue(history.rename(thread, '论文阅读笔记'))
            history.append(thread, '原始问题', '原始回答', None, [], {}, 'general', False,
                           state={'focus': [{'id': 'paper'}]})
            history.append(other, '保留的问题', '保留的回答', None, [], {}, 'general', False)
            reopened = ChatHistory(catalog)
            self.assertEqual(next(t['title'] for t in reopened.list() if t['id'] == thread), '论文阅读笔记')
            self.assertTrue(reopened.delete(thread))
            self.assertFalse(reopened.exists(thread))
            self.assertEqual(reopened.state(thread), {})
            self.assertEqual(reopened.context(thread, True, '原始问题'), [])
            self.assertEqual(reopened.turns(other)[0]['answer'], '保留的回答')
            self.assertFalse(reopened.delete(thread))
            self.assertFalse(reopened.rename(thread, '无法恢复'))
            with self.assertRaises(LookupError):
                reopened.append(thread, '迟到的回答', '不能重建已删除会话', None, [], {}, 'general', False)
            with catalog.connect() as db:
                self.assertEqual(db.execute('SELECT COUNT(*) FROM chat_memory_search').fetchone()[0], 1)
                self.assertEqual(db.execute('SELECT COUNT(*) FROM chat_turns').fetchone()[0], 1)

    def test_old_turn_recall_is_thread_scoped_and_survives_reload(self):
        with tempfile.TemporaryDirectory() as root:
            catalog = Catalog(Path(root))
            catalog.initialize()
            history = ChatHistory(catalog)
            thread = history.create()
            history.append(thread, "赤羽电池的寿命是多少", "37小时", None, [], {},
                           "evidence", True, state={"focus": [{"id": "paper-1"}]})
            for index in range(10):
                history.append(thread, f"普通话题{index}", "普通回答", None, [], {}, "general", False)
            other = history.create()
            history.append(other, "赤羽电池的寿命是多少", "另一会话", None, [], {}, "evidence", True)
            reopened = ChatHistory(catalog)
            self.assertEqual(reopened.state(thread)["focus"][0]["id"], "paper-1")
            recalled = reopened.context(thread, True, "赤羽电池的寿命")
            self.assertTrue(any(turn["answer"] == "37小时" for turn in recalled))
            self.assertFalse(any(turn["answer"] == "另一会话" for turn in recalled))
            general = reopened.context(thread, False, "赤羽电池的寿命")
            self.assertFalse(any(turn["answer"] == "37小时" for turn in general))
