/** 当前会话的真实用户问答，不构成操作授权。 */
export interface AgentQuestion {
  id: string;
  conversationId: string;
  branchId: string;
  question: string;
  options: string[];
  status: 'pending' | 'answered' | 'dismissed';
  answer: string | null;
  createdAt: number;
  updatedAt: number;
}
