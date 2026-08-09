import type {
  ReviewAttemptDto,
  ReviewWorkspaceDto,
} from "./dto";

/** 读模型游标形状（实现侧 cursor 的 DTO 级对应物；随 T-14 契约沉淀收窄）。 */
export type ReviewDeliveryPageCursor = {
  after: number;
  limit: number;
};

/**
 * review-delivery 公开查询面（DTO 级声明，不要求具体实现 implements）。
 * 当前具体实现为 src/adapters/outbound/sqlite/review-delivery/ 下的
 * review-read-service/delivery-read-service/review-slice-service 的
 * 连接级自由函数。复核工作台/交付读模型的精确 DTO 已沉淀进
 * src/shared/review-contracts（ReviewWorkspaceDto/DeliveryVersionDto 等），
 * 事件/历史分页的精确 envelope 随 T-14 契约沉淀收窄。
 */
export interface ReviewDeliveryQueries {
  readReviewWorkspace(
    databasePath: string,
    workItemId: string,
  ): ReviewWorkspaceDto;
  listReviewAttempts(
    databasePath: string,
    workItemId: string,
  ): ReviewAttemptDto[];
  readReviewAttemptDetail(
    databasePath: string,
    attemptId: string,
  ): Record<string, unknown>;
  listReviewEvents(
    databasePath: string,
    missionId: string,
    rawInput?: unknown,
  ): Record<string, unknown>;
  readMissionDelivery(
    databasePath: string,
    missionId: string,
  ): Record<string, unknown>;
  listMissionDeliveries(
    databasePath: string,
    missionId: string,
    cursor?: ReviewDeliveryPageCursor,
  ): Record<string, unknown>;
}
