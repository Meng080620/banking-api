export const NOTIFICATIONS_QUEUE = 'notifications';

export const TRANSFER_COMPLETED_JOB = 'transfer-completed';

export interface TransferCompletedJob {
  transferId: string;
  userId: string;
}
