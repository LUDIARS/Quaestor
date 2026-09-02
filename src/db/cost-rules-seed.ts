/**
 * 固定費 / 変動費と水道光熱費の既定ルール。 neco 指示: AI 代やソフトウェアの長期契約は固定費。
 * pattern は normalizePayee 後 (半角・大文字) の文字列に i フラグで当てる。
 * @implements SPEC-COST-STRUCTURE-001 (spec/feature/cost-structure.md)
 */

export type CostType = "fixed" | "variable";
export type UtilityKind = "electric" | "gas" | "water";

export interface CostRuleSeed {
  pattern: string;
  cost_type: CostType;
  utility?: UtilityKind;
  label: string;
  priority: number;
}

export const COST_RULE_SEED: CostRuleSeed[] = [
  // 水道光熱費 (固定費扱い、 種別付き)
  { pattern: "東京電力|TEPCO|でんき|電気料金|電力|ENEOSでんき|楽天でんき|ソフトバンクでんき|中部電力|関西電力|九州電力|東北電力|北海道電力|中国電力|四国電力|北陸電力", cost_type: "fixed", utility: "electric", label: "電気", priority: 10 },
  { pattern: "東京ガス|ニチガス|ガス料金|大阪ガス|東邦ガス|西部ガス|LPガス|プロパン", cost_type: "fixed", utility: "gas", label: "ガス", priority: 11 },
  { pattern: "水道料金|水道局|上下水道|下水道|水道使用料", cost_type: "fixed", utility: "water", label: "水道", priority: 12 },
  // AI / ソフトウェア (長期契約)
  { pattern: "OPENAI|CHATGPT|ANTHROPIC|CLAUDE\\.AI|CLAUDE|GEMINI|GOOGLE ONE|PERPLEXITY|CURSOR|GITHUB|COPILOT", cost_type: "fixed", label: "AI・開発サービス", priority: 20 },
  { pattern: "AMAZON\\s*WEB\\s*SERV|(?:^|[^A-Z0-9])AWS(?:[^A-Z0-9]|$)|NOTION|ADOBE|MICROSOFT|GOOGLE.*(WORKSPACE|GSUITE)|JETBRAINS|SLACK|ZOOM|DROPBOX|1PASSWORD|FIGMA|VERCEL|CLOUDFLARE|HEROKU|お名前|さくらインターネット|XSERVER|CONOHA", cost_type: "fixed", label: "ソフトウェア・クラウド", priority: 21 },
  { pattern: "APPLE COM BILL|APPLE\\.COM/BILL|ICLOUD|GOOGLE PLAY|NETFLIX|ネットフリックス|AMAZONプライム|AMAZON PRIME|PRIME VIDEO|SPOTIFY|YOUTUBE|DAZN|HULU|U-NEXT|DISNEY|NHK|KINDLE UNLIMITED", cost_type: "fixed", label: "サブスクリプション", priority: 22 },
  // 通信
  { pattern: "AU電話|AU携帯|AUカブコム|DOCOMO|ドコモ|SOFTBANK|ソフトバンク|楽天モバイル|UQ|Y!MOBILE|ワイモバイル|AHAMO|POVO|LINEMO|NURO|フレッツ|光回線|OCN|BIGLOBE|SO-NET|JCOM|J:COM|WIFI|WIMAX", cost_type: "fixed", label: "通信", priority: 30 },
  // 住居・保険・税
  { pattern: "家賃|管理費|共益費|住宅ローン|地代", cost_type: "fixed", label: "住居", priority: 40 },
  { pattern: "生命保険|損害保険|保険料|共済|SONY生命|ソニー生命|アフラック|AFLAC|明治安田|日本生命|第一生命|住友生命", cost_type: "fixed", label: "保険", priority: 41 },
  { pattern: "国民年金|国民健康保険|健康保険|住民税|市民税|県民税|固定資産税|自動車税", cost_type: "fixed", label: "税・社会保険", priority: 42 },
  { pattern: "駐車場|月極|ジム|スポーツクラブ|ANYTIME|エニタイム|学費|授業料|習い事|保育|学童", cost_type: "fixed", label: "定期契約", priority: 50 },
];
