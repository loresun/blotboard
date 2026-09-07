import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutFixture, assessLayout } from './audit-layouts.mjs';

test('live layout audit detects overlap, fixed-region damage, lost content and instability', () => {
  const before = layoutFixture();
  const after = structuredClone(before);
  let at = 0;
  for (const card of after.cards) {
    if (card.type === 'frame' || card.frameId) continue;
    card.x = 1000 + at % 4 * 1000;
    card.y = Math.floor(at / 4) * 500;
    at++;
  }
  assert.equal(assessLayout(before, after, structuredClone(after), 'grid').ok, true);
  const collision = structuredClone(after);
  collision.cards[1].x = collision.cards[0].x;
  collision.cards[1].y = collision.cards[0].y;
  assert.ok(assessLayout(before, collision, collision, 'grid').overlapPairs > 0);
  const blocked = structuredClone(after);
  blocked.cards[0].x = 20; blocked.cards[0].y = 20;
  assert.ok(assessLayout(before, blocked, blocked, 'grid').fixedOverlapPairs > 0);
  const edited = structuredClone(after); edited.cards[0].content = 'changed';
  assert.equal(assessLayout(before, edited, edited, 'grid').semanticsUnchanged, false);
  const again = structuredClone(after); again.cards[0].x += 20;
  assert.equal(assessLayout(before, after, again, 'grid').idempotent, false);
  const movedFrame = structuredClone(after); movedFrame.cards.find(c => c.type === 'frame').x += 10;
  assert.equal(assessLayout(before, movedFrame, movedFrame, 'grid').fixedUnchanged, false);
});
