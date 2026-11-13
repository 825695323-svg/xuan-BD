/** 不同入口的字节预算具有独立业务身份；由前后端共用，不从页面文案反推数值。 */
const MiB = 1024 * 1024;

/** 无原路径时，网页附件回退上传上限。 */
export const ATTACHMENT_UPLOAD_LIMIT = 25 * MiB;
/** 材料原件网络上传预算，独立于本机较大的保管预算。 */
export const MATERIAL_UPLOAD_LIMIT = 25 * MiB;
/** R1 批量原件清单数量与整批大小上限。 */
export const R1_BATCH_MAX_FILES = 100;
export const R1_BATCH_MAX_BYTES = 128 * MiB;
