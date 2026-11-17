# 文献知识库整体架构

v0.1 · 首版架构 · 2026 年 11 月 16 日

需求依据为[《文献知识库需求分析》v0.1](literature-knowledge-base-requirements.md)。主参考为 [RAGFlow v1.0.0，提交 db1cd59](https://github.com/infiniflow/ragflow/tree/db1cd5929a7885a3074547791f5ecc4d2f891739)。

## 1 架构决策

首版采用 **React 阅读工作台 + FastAPI 模块化单体 + 单后台入库线程**。部署假设为个人本地工作区。FastAPI 以单进程运行，持有唯一的本地 Chroma 客户端。入库任务落盘，由同一进程内的后台线程消费。PDF 解析、分块和向量化离开请求处理线程。后端重启后从数据库恢复未完成的任务。本机 Python 3.12 已验证可用 SQLite FTS5。[Chroma 嵌入式部署约束](https://cookbook.chromadb.dev/core/system_constraints/) · [SQLite FTS5](https://sqlite.org/fts5.html)

RAGFlow 是模块和数据流的主参考。我们沿用它的入库与在线问答分离、先搜索再读原文、会话与单次运行状态分离、以片段坐标驱动 PDF 引用的边界。首版以 SQLite 支撑本地任务和业务状态，用 LangGraph 在问答模块内编排单 Agent，通过现有 DeepSeek 客户端调用模型。[RAGFlow 入库执行器](https://github.com/infiniflow/ragflow/blob/v1.0.0/internal/ingestion/task/pipeline_executor.go) · [RAGFlow Agent 主循环](https://github.com/infiniflow/ragflow/blob/v1.0.0/internal/agentic_rag/agent.go) · [LangGraph 检索 Agent](https://docs.langchain.com/oss/python/langgraph/agentic-rag)

```mermaid
flowchart LR
    UI["React · 问答与 PDF 侧栏"]
    API["FastAPI · 单进程"]
    LIB["文献与入库服务"]
    JOB["后台入库线程"]
    CHAT["LangGraph · 问答编排"]
    SEARCH["检索与证据读取"]
    CITE["引用解析"]
    DB[("SQLite · 文献、任务、FTS5、会话")]
    VEC[("Chroma · 向量索引")]
    PDF[("本地存储 · PDF 原件")]
    LLM["DeepSeek API"]
    UI -->|导入、预览、提问| API
    API --> LIB
    LIB --> DB
    LIB --> PDF
    DB -->|领取任务| JOB
    JOB -->|读取原件| PDF
    JOB -->|片段及索引状态| DB
    JOB -->|向量写入| VEC
    API --> CHAT
    CHAT -->|只读工具| SEARCH
    SEARCH --> DB
    SEARCH --> VEC
    CHAT --> LLM
    CHAT --> CITE
    CITE --> DB
    API -->|原文件、流式答案及引用| UI
```

## 2 模块职责

- **文献与任务**（FR-01、FR-02）。管理文献、版本、标签、专题和上传任务。文件校验、登记和入队后立即返回任务 ID，页面轮询状态，失败文献可单独重试。
- **检索与原文**（FR-02、FR-04）。先按实际生效的文献范围取候选，再并行查 FTS5 和 Chroma，融合结果。读取工具按稳定 ID 返回原文和相邻片段。
- **问答编排**（FR-03 至 FR-05、FR-07）。解析模式和范围，调用 DeepSeek 筛证据、决定补查或澄清、生成回答。会话模块提供上一轮的文献对象和引用。
- **引用与阅读**（FR-06）。验证模型引用 ID，返回该版本 PDF 的页码和高亮坐标。React 中的问答区与阅读区各自滚动，沿用现有右侧栏布局。
- **存储与模型适配**。统一文件路径、数据库事务、索引接口和 DeepSeek 请求。模块通过这些接口访问外部依赖，App 入口负责组装依赖和注册路由。

## 3 数据归属与引用契约

**本地文件**保存原 PDF，以 SHA-256 做文件去重。**应用 SQLite**保存书目信息、专题、文献版本、索引任务、规范化原文片段、页码坐标、会话和引用记录。FTS5 与片段同库。**Chroma**只承担向量召回，存储片段标识、索引代次和检索所需元数据，索引可从本地数据重建。

- **文献与版本**。文献是书目实体，版本是可打开的原文件快照。预印本与正式版可关联到同一文献，引用保持指向实际使用的版本。标题、标签等更正与原文件版本的身份独立。
- **片段**。片段有 `chunk_id`、`document_id`、`version_id`、`index_generation_id`、`page_index`、章节、正文和页内矩形。片段限制在单页内，跨页内容通过读取上下文补齐。
- **引用**。一次问答为可用证据分配 `evidence_id`。最终引用持久化 `document_id`、`version_id`、`chunk_id`、`page_index`、`rects`、`excerpt`。前端按文献版本分组。内部 `page_index` 从 0 开始，页面向用户显示从 1 开始的 PDF 页序。
- **坐标**。`rects` 使用 PDF 可见页面经过旋转后的归一化坐标，左上为原点，每个矩形为 `[x0, y0, x1, y1]`。解析适配器负责把原库坐标归一化，PDF.js 将其投影到当前缩放的页面。只有文本的历史引用走原文文本高亮，可用时显示页码。[RAGFlow PDF 位置写入](https://github.com/infiniflow/ragflow/blob/v1.0.0/internal/ingestion/task/indexdoc/position.go) · [PDF.js](https://github.com/mozilla/pdf.js)

## 4 PDF 入库与索引发布

1. **上传与登记**。保存原文件、计算哈希，登记文献版本和入库任务。短事务写入任务，API 返回可查询的状态。定时或任务结束时清理未登记的临时文件。
2. **结构解析**。首版用 pdfplumber 提取文字层和位置，优先保留页面、段落和章节，双栏按阅读顺序组块。无可用文字层标记为需要 OCR，损坏或受密码保护的文件记录可理解的失败原因。可编辑的书目信息允许人工补齐，元数据抽取失败不影响可检索正文。[pdfplumber 项目与提取接口](https://github.com/jsvine/pdfplumber)
3. **构建新代次**。按新代次写入规范化片段和 FTS5，使用现有本地 BGE 生成向量后写入 Chroma。两个索引准备好后，SQLite 事务发布新的活动代次并标记任务完成。两个候选通道都按活动代次过滤，避免候选引用到准备中的片段。
4. **重试与清理**。以任务 ID 和代次实现幂等写入。失败保留上一个可用索引；服务重启后回收超时任务并重试。旧索引可以清理，系统保留原 PDF 和已发布引用的定位快照。文献删除后立即移出可查范围，旧会话按保留状态提示引用不可打开。向量模型变更在新集合重建索引，旧集合继续服务到新索引验证完成。[Chroma 嵌入与维度约束](https://cookbook.chromadb.dev/core/system_constraints/)

跨学科资料使用同一入库和检索契约，由专题、标签、版本和文献选择确定范围。多语言检索质量在中英文测试集上验证。首版沿用现有 BGE，后续替换模型统一走索引重建流程。

## 5 问答路由、工具与会话

**模式优先级**。后端首先应用用户的显式模式和范围。通用模式进入独立模型调用路径，向模型传入用户问题和必要的非文献对话上下文。仅查文献模式固定进入文献路径。自动模式根据问题、用户范围和会话指代选择直接回答、查文献或澄清；明确问库内事实时走文献路径。当前预览仅在「这篇」等明确指代出现时参与解析，用户可通过「仅问此篇」锁定范围。

**文献路径**。用 LangGraph 管理规划、工具执行、覆盖判断和生成节点。简单问题直接定位证据；比较题先明确对象和比较项，再按对象取证。本版先限制为一轮初查和一轮可选的定向补查。模型给出工具参数，应用执行权限、范围和预算校验。[LangGraph 条件分流与补查](https://docs.langchain.com/oss/python/langgraph/agentic-rag)

- `list_documents` 根据用户的范围查询书目和可检索状态，处理库内目录问题。
- `search_knowledge` 在授权范围内并行用 SQLite FTS5 BM25 和 Chroma 召回，以 RRF 合并排名。保留 DOI、专名和缩写，中文用一致分词，完整 DOI 也可走书目字段查询。结果返回片段 ID、摘要和页码。
- `read_passage` 按本轮文献范围内的有效片段 ID 读取原文，按需附带相邻片段，并登记到本轮证据表。模型随后按比较项判断证据覆盖。融合分数用于排序，证据覆盖以原文是否支持所问事实判断。[RAGFlow 搜索工具](https://github.com/infiniflow/ragflow/blob/v1.0.0/internal/agentic_rag/tool_search_chunks.go) · [RAGFlow 原文读取工具](https://github.com/infiniflow/ragflow/blob/v1.0.0/internal/agentic_rag/tool_list_chunks.go)

**答案与降级**。证据充分就生成带引用的回答，部分充分就写清可确认的内容和待查项。自动模式在无依据时允许带标识的通用解释；仅查文献模式说明缺少证据。处理错误和无证据是不同状态，源文件解析失败、检索异常和模型超时都返回可区分的提示。文献内容作为不可信数据交给模型，工具只读且由后端审核参数。

**会话边界**。SQLite 按 `thread_id` 保存已完成的消息、显式范围、比较对象和引用，用于把「第二篇」解析为正确版本。每次 Agent 运行的工具结果和剩余预算保留在本轮内存状态。中断后标记该轮中断，重试从已完成历史恢复上下文。新会话建立独立范围。[RAGFlow 单次执行状态](https://github.com/infiniflow/ragflow/blob/v1.0.0/internal/agentic_rag/run_session.go) · [RAGFlow 会话历史](https://github.com/infiniflow/ragflow/blob/v1.0.0/internal/dao/conversation_history.go)

## 6 API 与原文阅读交互

- 导入 API 接收 PDF 并返回文献版本和任务 ID。状态 API 暴露解析进度、失败原因和重试入口。
- 文献 API 查询书目和版本元数据，按版本读取原 PDF，支持浏览器分页预览所需的范围请求。
- 沿用 `POST /api/chat` 和 NDJSON。请求携带模式、会话、用户选定范围和预览文献 ID。流增加模式与任务进度事件，继续传输正文、最终引用和完成状态。
- 模型生成引用标记时只允许指向本轮证据表。后端在完成事件前验证编号和版本，并返回最终引用；前端用已验证的数据渲染点击目标。存在正文引用时，参考原文区仅提供按文件聚合的入口，移除片段数量及重复编号按钮；正文引用仍精确选中对应证据。点击后加载原版本的完整 PDF，滚动到首个引用页，并提供命中页快捷跳转。PDF.js 只绘制可视区域附近的页面，缩放及栏宽变化时按同一归一化坐标重绘高亮。定位失败时展示保存的证据原文及原因。[RAGFlow 引用解析](https://github.com/infiniflow/ragflow/blob/v1.0.0/internal/service/agentic_reference.go) · [RAGFlow PDF 高亮组件](https://github.com/infiniflow/ragflow/blob/v1.0.0/web/src/components/document-preview/pdf-preview.tsx)

### 当前实现

- 本地开发时，浏览器向 Vite 同源路径 /api 发请求，由 Vite 转发至 FastAPI。开发后端默认监听 8001，可通过 VITE_DEV_API_TARGET 指定另一个后端地址。

- PDF 片段携带 SHA-256 文件版本、从零开始的页序和旋转后的归一化矩形。右侧阅读区通过 `GET /api/documents/{doc_id}/file?version_id={sha256}` 读取指定原件并在 PDF.js 中跳页和高亮。原件缺失或内容与版本不符时返回 404，前端显示上次检索保存的摘录。
- 首次启动将旧 JSON 目录导入 SQLite，并登记已有 Chroma 片段。新文件按 SHA-256 与文件类型共享原件，同文件夹内重复导入复用现有文献。替换版本通过 `POST /api/documents/{doc_id}/versions` 提交，文献 ID 与名称沿用原记录。
- 会话 API 新增 `PATCH /api/chat/threads/{thread_id}` 更新名称（JSON `title`，合并空白后1至100字符），`DELETE /api/chat/threads/{thread_id}` 在同一事务删除消息、FTS5记忆与会话状态，成功返回204，不存在返回404。保存问答和删除均使用写事务串行化，已删除会话的迟到回答不会产生孤立消息。前端删除当前会话后清空问答和引用预览，删除其他会话保留当前阅读状态。
- 会话 API 通过 `GET/POST /api/chat/threads` 列出或创建会话，`GET /api/chat/threads/{thread_id}` 读取已完成轮次。聊天请求携带可选的 `thread_id`，服务端在回答成功后保存问答、范围和引用。SQLite 在保存问答的同一事务中保存当前对象和有序文献组快照，并将原问与原答写入 FTS5 会话索引。路由接收最近六轮及全会话检索的最多四个相关旧轮次。指代由模型选择当前对象、整组、排除当前对象后的其余文献或序号，再由后端按真实 ID 与用户范围解析，文献事实重新查证。失败查找不更新当前对象，旧会话可从已核验的来源恢复状态。关闭 RAG 时排除曾使用知识库的轮次。
- 附件同时加入知识库时，前端并行调用上传与仅解析接口。解析出的文本随下一条消息提交，后台索引独立进行。
- 上传、替换和重建索引返回 202。前端通过目录列表轮询状态，`GET /api/documents/{doc_id}/ingestion` 也可查询单篇状态。文档管理中可对失败任务重试，对可检索文献重建索引。服务重启后重新排队未完成任务。
- PDF 批注按文献版本存储。`pdf_annotations` 保存页码、归一化矩形、类型（高亮/下划线）和选中文本；`GET/POST/PATCH/DELETE /api/documents/{doc_id}/annotations` 提供读写，写入前校验版本哈希。前端在 PDF.js 文字层上直接选中文字，坐标按页宽高归一化，缩放时按百分比重绘。备注功能已移除，历史备注数据保留在库中但不再展示；旧版本批注不显示。
- 文献元数据由后台补全：先从 PDF 文档信息和前两页 DOI 提取，再按 DOI 查 Crossref、按标题查 OpenAlex（标题相似度不低于 0.9），只填充空字段并记录 `metadata_source` 与 `metadata_checked_at`。手动编辑标记为 `manual`，自动流程不再覆盖；`POST /api/documents/enrich-metadata` 可批量补全，启动时最多处理 20 篇未检查文献，`RAG_AUTO_METADATA=0` 可关闭，`OPENALEX_MAILTO` 用于加入 OpenAlex 礼貌池。`PUT /api/documents/{doc_id}/metadata` 支持标题、作者、年份、期刊/会议、DOI 和标签。知识库表格按标题、作者、年份、来源、DOI 与标签搜索，并可按出版年份排序。
- Chroma 1.x 在 Windows 非 ASCII 路径下无法重新加载 HNSW 索引。向量库默认落在数据目录同盘的 `rag-kb-chroma-<hash>`（盘符根目录不可写时改用 `C:\Users\Public`），可用 `RAG_CHROMA_DIR` 指定；SQLite、原件与片段仍在 `RAG_DATA_DIR`。同一数据目录只能由一个后端进程持有；集合加载失败不会自动删除，需先停止其他后端进程。
- 后台先按任务 ID 暂存向量，再在单个 SQLite 事务中写入规范化片段、更新 FTS5、替换活动代次，并标记任务完成。问答与检索接口基于同一活动代次过滤向量。替换失败时，旧代次和原件继续可用。已发布 PDF 原件保留到移除该文献，旧引用仍可打开相应版本。FTS5 已随入库更新，问答的混合召回由下一阶段接入。

- 开启知识库时，DeepSeek 先依据用户问题生成结构化路由，选择目录、概览、正文证据或通用回答。路由接收当前问题、会话工作状态、有界历史与当前文献目录，文件夹和文献名称在本地目录解析，并与请求的文献范围取交集。目录查询直接返回真实文件夹、文献或状态；同名与未匹配时给出相应提示。
- 只提交准确文件名时，先确认当前选中文献，并询问概览、深读或比较任务。文献概览按研究问题、方法、结果、局限和适用场景组织，只陈述实际片段支持的内容。
- 全文阅读与主题检索分流：`QuestionPlan.reading_mode` 由模型选择 `auto/full/local`。概览固定走全文；已明确文献 ID 的正文问答在 `auto/full` 下读取全文，明确局部问题用 `local`，未指定文献的主题问题用混合检索。文件夹和全文献概览不再抽取八篇、每篇十四个片段。`KnowledgeReadSession.read_documents` 在索引锁内一次取得当前范围全部活动代次片段，按文献及 `chunk_index` 排序，连同版本、页码及矩形保留原文证据，随后释放锁再调用模型。
- `document_reading.py` 使用 24,000 UTF-8 字节作为正文预算，另留问题、历史和输出空间。短文直接提交正文，长文按预算逐批生成带引用的结构化笔记，必要时递归汇总。每批使用连续的来源编号，服务端逐条校验笔记并映射回原始片段。批次输出为空、截断或引用越界时最多重试一次。仍未通过校验时，保留有效笔记并用对应文献的原文节选补充。汇总超出预算且无法继续收敛时，使用预算内的原文节选继续回答。汇总后按剩余预算补充所引用的原始片段，用于核验数据和措辞。API 非流式响应和 NDJSON `end` 的 `reading.partial` 表示本轮使用了节选补充，回答说明可能遗漏细节。用量计入全部阅读调用。
- 流式问答在路由规划和全文阅读之前建立 NDJSON 响应，等待期间每 10 秒发送 `heartbeat`，前端忽略该事件。正文、引用核验和会话保存沿用既有事件协议，准备阶段的异常转换为 `error` 事件。
- 全文指**全部已解析正文**，不包含未提取的扫描图像或图表。长文先阅读后流式生成最终回答，首字等待及模型用量会增加；分层笔记存在信息压缩，可定向追问回读原文。阅读范围计数和汇总过程仅保留在接口诊断数据中，不加入答案；前端兼容隐藏旧会话中的相应提示。最终模型提示要求直接回答，不输出内部流程。引用始终使用原始片段与既有 PDF 坐标，正文来源按文件聚合，点击编号仅定位该原文片段。局部检索对排名靠前的四个片段扩展左右相邻片段，避免语义边界被分片切断。
- 实现借鉴 LlamaIndex 的整篇节点读取与递归汇总、Haystack 的命中上下文扩展，未复制上游代码。[SummaryIndexRetriever](https://github.com/run-llama/llama_index/blob/99d7433f6f71888951379ccca9294e272442c832/llama-index-core/llama_index/core/indices/list/retrievers.py) · [TreeSummarize](https://github.com/run-llama/llama_index/blob/99d7433f6f71888951379ccca9294e272442c832/llama-index-core/llama_index/core/response_synthesizers/tree_summarize.py) · [SentenceWindowRetriever](https://github.com/deepset-ai/haystack/blob/a08e4e981c20eff63a99e5a9c3a207bea089a2ce/haystack/components/retrievers/sentence_window_retriever.py)
- 问答默认并行执行 FTS5/BM25 与 BGE 向量召回，再以 RRF 合并。FTS5 使用相同的中文分词规则处理片段及查询，并保留英文缩写、编号和 DOI。升级时从 SQLite 已有片段重建全文索引，无需重新嵌入或上传。
- `POST /api/knowledge/list`、`/search`、`/read` 提供列出文献、搜索和读取原文。三者可接收 `document_ids`、`folder_ids`，同时提供时取交集。两路召回只读活动代次。搜索返回候选，原文读取验证范围和代次后才分配本轮证据 ID，可同时读取前后相邻片段。
- `POST /api/retrieve` 通过 `retrieval_mode` 选择 `hybrid` 或 `vector`。排序信号用于比较召回效果，证据仍由原文是否支持所问事实决定。聊天结束事件提供本轮实际路由，用量包含路由调用。从 `backend` 运行 `python -m unittest discover -s tests -p test_retrieval.py` 可在临时数据目录复现排名对照、范围过滤及跨版本引用检查。

会话状态与证据状态分别参考 RAGFlow 的运行会话和 Haiku.RAG 的 evidence ledger。当前实现继续沿用项目已有 FastAPI 与 SQLite，对应逻辑位于 chat_history.py 和 conversation_state.py。记忆用于确定阅读对象和任务，实际文献结论重新读取来源，来源版本改变时提示重新选择。[RAGFlow 运行会话](https://github.com/infiniflow/ragflow/blob/db1cd5929a7885a3074547791f5ecc4d2f891739/internal/agentic_rag/run_session.go) · [Haiku.RAG 证据状态](https://github.com/ggozad/haiku.rag/blob/76e6b325b8c94eb5a234df27370ade3c1862032a/haiku_rag_slim/haiku/rag/capabilities/ledger.py)

### 引用证据链（当前实现）

解析继续使用 pdfplumber 的原页坐标链路，借鉴结构化文档元素与证据登记思路，不叠加另一个 Agent 框架。`pdf_evidence.py` 根据持续栏间空白推断双栏，按字体、行距和缩进归并段落及章节，保留可检测的线框表格边界。阅读块按 `cl100k_base` 的384 token预算切分/合并；这是明确的分块计量规则，不是 DeepSeek 计费或相关性阈值。过长元素按句子或词边界分段，保留全部字符。块保持页内范围，附带章节、元素ID、元素内偏移、文字哈希，以及行/词矩形与字符偏移映射。英文按词定位，中文按字定位；连字通过NFKC对齐，仅在文字与字形无损对应时提供词矩形，否则降级为行定位；精细映射仅写SQLite，不复制到Chroma。无框表格、复杂公式及图像仍可能只能保留文字，不声称完整恢复其语义结构。

阅读块、回答论断、引用证据独立处理。`evidence_grounding.py` 在生成后对每个引用出现位置提取对应论断，读取所指块及邻接原文，由模型返回支持判断和逐字引句。引句须在原文中唯一匹配，论断须来自回答，版本与文字哈希须一致；显式数值必须能在引句中找到。不足时仅在同一文献、同一版本内定向混合检索并补读，再核验一次。同一论断已有其他可靠引句时移除冗余的不支持引用；整条论断仍无可靠证据时，将原断言改为依据不足提示，不保留未经核实的数值或附可点击链接。模型的支持判断是概率性检查，不是事实正确性的形式证明；数值字面校验保守处理，推算型结论可能需要后续显式推导证据支持。

通过核验的来源保存 `span_id`、`claim`、`excerpt_start/end`、`element_refs`、原文版本、页码和仅覆盖引句的矩形；同一证据去重，编号从1紧凑排列。没有精细映射的旧证据按行或页降级，不伪称精确到词。最终可点击引用只来自这些来源，历史引用记录保留自带的旧版本和矩形。

NDJSON继续流式发送正文草稿，核验后发送 `answer` 事件作为最终权威正文，随后发送通过核验的 `sources` 与 `end`；前端替换草稿正文，持久化同一最终答案。非流式接口直接返回最终答案。`end.grounding` 记录核验与补读数量，计费包含核验调用，内部指标不显示在回答。核验服务失败不保存该轮，返回明确错误。

解析器带 `paragraph-spans-v3` 版本。启动时为旧PDF索引排队一次升级，同一文献不重复排队；构建期间沿用旧活动代次，成功后原子切换，失败保留旧索引。原文件与聊天记录不因升级删除。重新登记时若精细映射缺失，也会重建，避免将缺失映射的索引误认成已升级。

参考实现：[Haiku.RAG 结构化切分](https://github.com/ggozad/haiku.rag/blob/43a853004d14c13d5c15a032efa184e1bbd5efe1/haiku_rag_slim/haiku/rag/chunkers/docling_local.py)、[原文元素定位](https://github.com/ggozad/haiku.rag/blob/43a853004d14c13d5c15a032efa184e1bbd5efe1/haiku_rag_slim/haiku/rag/client/search.py)、[Kotaemon 引句匹配](https://github.com/Cinnamon/kotaemon/blob/9ad3e4e49aa35b8acddd235918a5d9753c1cfdf9/libs/kotaemon/kotaemon/indices/qa/citation_qa_inline.py)、[RAGFlow PDF合并与切分](https://github.com/infiniflow/ragflow/blob/441273988d4c1126b32aef02f21e7cfeb9eeeb33/internal/ingestion/component/chunker/general.go)、[RAGFlow证据登记](https://github.com/infiniflow/ragflow/blob/441273988d4c1126b32aef02f21e7cfeb9eeeb33/internal/agentic_rag/evidence_registry.go)。

### 章节结构与读取

`document_structure.py` 从当前有序片段构建章节树。复用现有标题规则，保存父子关系、顺序、包含子章节的正文区间及页区间。SQLite 的 `document_sections`、`section_passages` 和 `section_index_versions` 分别保存章节、原始片段归属和结构配置。相同原件、解析配置及片段顺序重建时章节 ID 稳定，原件版本变化时生成新 ID。

`IngestStore.initialize` 在事务中幂等补齐旧库结构，保留片段内容、ID、元素和坐标。`_activate` 将新结构与新正文在同一事务中发布，文献删除同时清理结构关系。旧会话继续使用既有引用快照和原文件版本。

`GET /api/documents/{id}/sections` 返回当前章节及版本、代次。`POST /api/knowledge/read-section` 在当前文献范围内按原文顺序读取章节和子章节，支持 offset/limit，并拒绝过期版本或代次。读取结果沿用原文证据契约，并增加 `section_id`。章节读取与发布共用索引锁以固定单次读取的代次。

阅读页的 `SectionReader` 提供章节选择、分页阅读和 PDF 文段定位。标题识别质量仍受现有解析结果影响。

### 带证据的章节摘要与论文卡片（已实现）

`document_profiles.py` 在活动索引锁内一次取得章节结构和全部已解析正文，固定文献版本与索引代次，释放锁后执行模型调用。按 UTF-8 字节预算分批阅读，生成单一事实的候选要点。每项保存 facet、摘要文字和逐字引句来源。应用复用 `quote_span` 定位原句、检查版本与正文哈希，并拒绝引句未包含的显式数值；独立模型步骤复核语义支持及所属类别。局限和适用条件须指向本论文，相关工作的问题不自动视为本论文局限。模型复核是质量控制，不能视为事实正确性的形式证明。

论文卡片按研究问题、方法、发现、条件、局限选择各一至两条已核验要点。选择阶段只返回已有 ID，字段缺失保持空数组。章节摘要按原文所属章节归并，父章节包含子章节要点，原始正文始终独立保留。未读到可靠要点的章节明确显示缺失，不生成补全事实。摘要仅覆盖已解析文字，不保证覆盖扫描图表或所有论断。

`profile_store.py` 使用 SQLite `profile_jobs` 持久化队列、批次检查点和任务状态，`document_profiles` 保存完整结果。单工作线程串行处理，避免新上传同时触发无限并发。提交、检查点和发布分别校验活动文献版本与代次，已删除或已替换文献的迟到结果不会发布。重复请求合并；失败重试及重启从检查点恢复，强制重新生成从头开始。缓存键包含索引代次、模型、提取/复核/选择 Prompt、结构版本和预算配置；变更时旧结果不会成为当前卡片。强制刷新失败保留此前有效缓存。任务用量、模型调用数和生成配置随结果保存。

`GET /api/documents/{id}/profile` 查询当前状态及结果，`POST` 接受可选 `version_id` 与 `force`，返回 202。版本过期返回 409。`Ingestion.on_publish` 在索引成功提交后排队，卡片失败不会回滚可检索正文；`RAG_AUTO_PROFILE=0` 可关闭自动排队。阅读页 `PaperProfile.tsx` 展示五类卡片、章节摘要与可展开原句，沿现有来源契约回到 PDF 原页高亮，前端只展示任务进度与有效内容。论文级召回、全库专题和主题图谱仍待后续实现。

## 7 迁移、开发顺序与验收

1. **先验证 PDF 坐标纵贯链路**。实现带版本的少量 PDF 解析与右栏页内高亮，测试中文、英文、双栏、旋转或裁切的样本，确认同一坐标在不同缩放下指向正确位置。这一步覆盖 FR-01 和 FR-06 的关键风险。
2. **完善入库与检索**。新增 SQLite 数据结构和任务模块，将现有 JSON 元数据导入并对原件重新解析。旧记录缺少页码和坐标时保留文本引用，待新索引就绪后切换。验证失败重试、重建期间旧索引可查、文献范围过滤和跨版本引用。
3. **接入问答 Agent 和会话**。在现有流式接口后分阶段接入模式分流、只读工具、定向补查及会话历史。以 FR-03 至 FR-07 的题集比较现有固定流程和新流程，记录查库判断、证据命中、页码准确、追问指代和耗时。
4. **完成首版验收**。演示两篇文献的导入、比较、补查、点击 PDF 原页和开着侧栏追问。再用一条通用题和一条库内无证据题对照路由。性能目标在基线测试后确定。

待确认事项仍包括首批示范专题、中英文 PDF 的覆盖范围及公网演示。该架构按个人本地运行确定；公网部署另行评审身份验证、访问隔离、上传限额和日志保留。
