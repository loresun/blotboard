import { assertCanWrite } from '@/lib/auth';
import { ApiError, badRequest, clientRevision, ok, readJson, route } from '@/lib/http';
import { assertBoardId } from '@/lib/board-schema';
import { boardDetail } from '@/lib/board-service';
import { boardHistoryState, historyHash, prepareHistoryStep } from '@/lib/board-history';
import { scheduleIssueSync } from '@/lib/issue-sync';
import { mutateBoard, requireBoard } from '@/lib/storage';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ boardId: string }> };
export const GET = route(async (_request: Request, ctx: Ctx) => {
  const id = assertBoardId((await ctx.params).boardId);
  return ok({ history: boardHistoryState(requireBoard(id)) });
});
export const POST = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const id = assertBoardId((await ctx.params).boardId);
  const body = await readJson(request);
  if (body.action !== 'undo' && body.action !== 'redo') throw badRequest('action 必须是 undo 或 redo');
  const revision = clientRevision(request);
  if (revision === null) throw badRequest('撤销与重做需要 x-board-since 当前画板版本');
  const current = requireBoard(id);
  if (revision !== current.updatedAt) throw new ApiError('画板已被其他操作修改，请刷新后重试', 409);
  const expectedHash = historyHash(current);
  const prepared = prepareHistoryStep(current, body.action);
  const board = mutateBoard(id, (target, data) => {
    if (target.updatedAt !== revision || historyHash(target) !== expectedHash) throw new ApiError('画板已被其他操作修改，请刷新后重试', 409);
    if (prepared.next.parentId !== target.parentId && prepared.next.parentId) {
      const parents = new Map(data.boards.map((item) => [item.id, item.parentId]));
      const visited = new Set([target.id]);
      let parent: string | null | undefined = prepared.next.parentId;
      while (parent) {
        if (visited.has(parent)) throw new ApiError("恢复父画板会形成循环，请先调整画板层级", 409);
        visited.add(parent);
        parent = parents.get(parent);
      }
    }
    const updatedAt = Math.max(Date.now(), target.updatedAt + 1);
    // The prepared board comes from private, validated deltas, never a client snapshot.
    for (const key of ['group', 'parentId', 'settings'] as const) {
      if (!Object.hasOwn(prepared.next, key)) delete target[key];
    }
    Object.assign(target, prepared.next, { updatedAt });
    return target;
  }, { history: false });
  prepared.commit();
  scheduleIssueSync(board.id);
  return ok({ board: boardDetail(board), history: boardHistoryState(board), action: body.action, label: prepared.label });
});
