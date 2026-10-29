export interface DirectChatEntry {
  sequence: number;
  id: string;
  conversationId: string;
  requestId: string;
  text: string;
  response: string | null;
  taskId: string | null;
  createdAt: string;
}
export interface DirectChatPage {
  conversationId: string;
  messages: DirectChatEntry[];
  before: string | null;
  hasMore: boolean;
}
