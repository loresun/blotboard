### 子画板（board）

把另一块画板当成本板上的一个节点，双击下钻。`boardRef.{boardId,name}`（name 冗余存一份：
目标板被删后还看得出指过谁）。卡面画的是目标板缩略图（`GET /api/boards/{id}/preview`），自动更新。
建配套子板：`POST /api/boards` 带 `parentId`（子板默认继承父板分组）。
看到 board 卡就知道下面还有一层——别以为一块板就是全部。
