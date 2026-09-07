"use client";

/** 子画板卡的前端槽位。 */
import { ICON_SM, TYPE_ICON, UI } from "@/lib/icons";
import { useBoardStore } from "@/lib/store";
import { BoardPreview } from "@/components/cards/BoardPreview";
import { useT } from "@/lib/i18n/client";
import type { CardPackUi, EditorFieldsProps } from "@/lib/card-pack-client";

const SubBoardIcon = TYPE_ICON.board;

function Fields({ draft, patch }: EditorFieldsProps) {
  const t = useT();
  const boards = useBoardStore((state) => state.boards);
  const currentBoardId = useBoardStore((state) => state.boardId);
  const targetBoard = draft.targetBoard as string;
  return (
    <>
      <span className="hint">{t("cards.board.pickHint")}</span>
      <select value={targetBoard} onChange={(event) => patch({ targetBoard: event.target.value })}>
        <option value="">{t("cards.board.noneOption")}</option>
        {boards
          .filter((item) => item.id !== currentBoardId)
          .map((item) => (
            <option key={item.id} value={item.id}>
              {t("cards.board.option", { name: item.name, count: item.counts.cards })}
            </option>
          ))}
      </select>
      <button
        type="button"
        className="mini-btn"
        disabled={!targetBoard}
        onClick={() => {
          const state = useBoardStore.getState();
          const name = boards.find((item) => item.id === targetBoard)?.name || targetBoard;
          void state.drillInto(targetBoard, name).catch((err: Error) => state.showToast(err.message));
        }}
      >
        <UI.expand {...ICON_SM} /> {t("cards.board.enterSub")}
      </button>
    </>
  );
}

export const ui: CardPackUi = {
  CardFace({ card, onAction }) {
    const t = useT();
    const target = card.boardRef;
    const targetId = target?.boardId || "";
    /**
     * 卡数与目标板名都**订阅**着左栏那份画板清单，而不是 `getState()` 读一次。
     * 读一次的写法在别的地方触发重渲染之前一直显示旧数字——目标板加了几张卡，
     * 这张卡面上还写着昨天那个数。
     *
     * 两个 selector 都只取 primitive：直接返回 `counts` 那个对象的话，
     * 每次比较都是新引用，Zustand 会认为快照一直在变。
     */
    const liveCount = useBoardStore((state) => state.boards.find((item) => item.id === targetId)?.counts.cards ?? null);
    const liveName = useBoardStore((state) => state.boards.find((item) => item.id === targetId)?.name ?? "");
    const savedName = target?.name || "";
    /**
     * 卡上这个名字是**建卡时抄下来的**，之后目标板改名它不会跟着变——这是有意的：
     * 用户常常把它当成自己给这块子板起的别名。但别名一旦跟目标现在的名字对不上，
     * 就有「点进去发现不是那块板」的风险，所以两边都摆出来，不动那个别名。
     */
    const drifted = Boolean(liveName && savedName && liveName !== savedName);
    // 卡头已经在顶栏写着标题了，页脚再挂一遍同一串长名字是纯重复——
    // 只有「卡片自己没标题」或「标题跟目标板名字不是一回事」时，名字才值得占页脚的地方。
    // 取名字时把订阅到的现名也算上：没抄下别名的卡（savedName 为空）照样能显示目标现在的名字。
    const footName = savedName || liveName || targetId || "";
    const showName = !targetId || (card.title || "").trim() !== footName;
    return (
      <div className="card-stack">
        <div className="grow subboard">
          {target?.boardId ? (
            <BoardPreview boardId={target.boardId} />
          ) : (
            <span className="placeholder">{t("cards.board.empty")}</span>
          )}
        </div>
        {/* 页脚不换行：卡数与「进入」永远在同一行的两头，换张卡也不会跳位置 */}
        <div className="task-foot subboard-foot nodrag">
          {showName ? (
            <span className="meta-chip">
              <SubBoardIcon {...ICON_SM} />
              <span>{footName || t("cards.board.unset")}</span>
            </span>
          ) : null}
          {/* 别名与目标现名对不上时，现名单独挂一颗——即使上面那颗名字因为跟卡头重复而没画。 */}
          {drifted ? (
            <span className="meta-chip board-live-name" title={t("cards.board.liveName.title", { name: liveName })}>
              {liveName}
            </span>
          ) : null}
          {liveCount !== null ? (
            <span className="meta-chip mono">{t("cards.board.countChip", { count: liveCount })}</span>
          ) : null}
          <span className="foot-spacer" />
          <button className="card-action" data-act="open-board" onClick={() => onAction("open-board")}>
            <UI.expand {...ICON_SM} />
            {t("cards.board.enter")}
          </button>
        </div>
      </div>
    );
  },
  FullView({ card }) {
    // 阅读模式的舞台够大，整块板铺开看得最清楚：不缩栏、不裁切
    return card.boardRef?.boardId ? <BoardPreview boardId={card.boardRef.boardId} variant="full" /> : null;
  },
  editor: {
    draftFrom(card) {
      return { targetBoard: card.boardRef?.boardId || "" };
    },
    buildPatch(card, draft) {
      if (!draft.targetBoard) return {};
      const boards = useBoardStore.getState().boards;
      const name = boards.find((item) => item.id === draft.targetBoard)?.name || card.boardRef?.name || "";
      return { boardRef: { boardId: draft.targetBoard, name } };
    },
    Fields,
  },
  toolbar: {
    title: "子画板：把另一块画板放进这块板，双击下钻",
    group: 3,
    order: 20,
    onClick: (ctx) => ctx.addSubBoard(),
  },
};
