/**
 * コールアウト配置計算。
 *
 * confirm フェーズで「検知した文字の BB」(画像上の実位置) と、その演出テキスト
 * (ラベル / 認識テキスト / 値 / 信頼度) を **離して** 描くための座標を計算する。
 *
 * - BB が画面左半分にあれば callout を右マージンへ、右半分なら左マージンへ逃がす。
 * - 同じ側の callout は縦に積んで重ならないようスロット割当する。
 * - リーダー線は BB の近い辺の中点 → callout の内側辺の中点。
 *
 * 純関数。React/DOM に依存しない (テスト可能)。座標は全て CSS px (コンテナ基準)。
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CalloutPlacement {
  id: string;
  /** callout ボックスの左上 */
  callout: { left: number; top: number; width: number };
  /** リーダー線 始点 (BB 側) */
  from: { x: number; y: number };
  /** リーダー線 終点 (callout 側) */
  to: { x: number; y: number };
  /** callout がコンテナのどちら側か */
  side: "left" | "right";
}

export interface LayoutInput {
  id: string;
  rect: Rect;
}

const CALLOUT_W = 120;     // callout 幅 (px)
const SLOT_H = 34;         // callout 1 スロットの高さ (px)
const EDGE_MARGIN = 6;     // コンテナ端からの余白
const STREAM_W = 20;       // 左右データストリーム帯の幅 (避ける)

/**
 * 本物 BB 群に対する callout 配置を計算する。
 * @param items  source=real 領域の CSS rect リスト
 * @param container コンテナ実寸 (px)
 */
export function layoutCallouts(
  items: LayoutInput[],
  container: { width: number; height: number },
): CalloutPlacement[] {
  const midX = container.width / 2;

  // 左右に振り分け
  const left: LayoutInput[] = [];
  const right: LayoutInput[] = [];
  for (const it of items) {
    const cx = it.rect.left + it.rect.width / 2;
    (cx < midX ? right : left).push(it); // 左にある BB → 右へ逃がす
  }

  return [
    ...placeSide(right, "right", container),
    ...placeSide(left, "left", container),
  ];
}

function placeSide(
  items: LayoutInput[],
  side: "left" | "right",
  container: { width: number; height: number },
): CalloutPlacement[] {
  // BB の縦位置順に並べてスロットを上から詰める
  const sorted = [...items].sort(
    (a, b) => (a.rect.top + a.rect.height / 2) - (b.rect.top + b.rect.height / 2),
  );

  const colLeft = side === "right"
    ? container.width - STREAM_W - EDGE_MARGIN - CALLOUT_W
    : STREAM_W + EDGE_MARGIN;

  const maxSlots = Math.max(1, Math.floor((container.height - 24) / SLOT_H));
  let prevBottom = -Infinity;

  return sorted.map((it, i) => {
    const bbCy = it.rect.top + it.rect.height / 2;

    // 理想は BB の縦中心。重なり回避で下へ押し下げ、コンテナ内にクランプ。
    let top = bbCy - SLOT_H / 2;
    top = Math.max(top, prevBottom + 4);
    top = Math.min(top, container.height - EDGE_MARGIN - SLOT_H);
    if (i >= maxSlots) top = container.height - EDGE_MARGIN - SLOT_H; // 溢れは端へ
    prevBottom = top + SLOT_H;

    // リーダー線: BB の近い辺の中点 → callout の内側辺の中点
    const calloutInnerX = side === "right" ? colLeft : colLeft + CALLOUT_W;
    const fromX = side === "right" ? it.rect.left + it.rect.width : it.rect.left;
    const calloutCy = top + SLOT_H / 2;

    return {
      id: it.id,
      side,
      callout: { left: colLeft, top, width: CALLOUT_W },
      from: { x: fromX, y: bbCy },
      to: { x: calloutInnerX, y: calloutCy },
    } satisfies CalloutPlacement;
  });
}
