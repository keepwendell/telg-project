# Unit Tests（后端单测，规划中）

当前后端未建单测。建议补齐以下覆盖点：

- `estimate_timeline`：句数/时长边界
- `build_artifact`：字段正确性（含 A2 speechRate 修复回归）
- LLM 返回校验与重试逻辑（pydantic + 错误自纠）
- `test_tts`：自定义文本、音色回退
- `insert_artifact` / CRUD / 删除级联（A4）

运行方式（接入后）：

```bash
cd backend && python -m pytest ../tests/unit -q
```
