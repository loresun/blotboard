/** PDF 卡与图片卡共用同一个 file 字段：schema 钩子从 image 包复用，只差报错文案里的类型名。 */
import { fileCardSchema } from "@/cards/image/schema";
import type { CardPackSchema } from "@/lib/card-pack-types";

export const schema: CardPackSchema = fileCardSchema("pdf");
