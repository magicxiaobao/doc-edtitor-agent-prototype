import { UserRole } from '../types';

export type ActionName =
  | 'confirm_facts'
  | 'confirm_style'
  | 'confirm_outline'
  | 'edit_draft'
  | 'generate_draft'
  | 'adopt_revision'
  | 'resolve_comment'
  | 'restore_version'
  | 'finalize'
  | 'add_comment'
  | 'submit_material'
  | 'supplement_fact';

export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Unified permission verification for user roles.
 * - 主笔甲: 事实/文风/大纲确认、编辑正文、采纳建议、处理意见、恢复版本、定稿、材料提交
 * - 审阅乙 / 审阅丁: 读稿、提出意见批注
 * - 供稿丙: 提交材料、补充说明事实候选
 */
export function checkPermission(role: UserRole, action: ActionName): PermissionCheckResult {
  switch (action) {
    case 'confirm_facts':
    case 'confirm_style':
    case 'confirm_outline':
      if (role === '主笔甲') return { allowed: true };
      return {
        allowed: false,
        reason: `权限受限：当前身份为【${role}】，无权核准或确认。事实、文风与大纲仅允许“主笔甲”审核确认。`,
      };

    case 'edit_draft':
    case 'generate_draft':
    case 'adopt_revision':
    case 'restore_version':
      if (role === '主笔甲') return { allowed: true };
      return {
        allowed: false,
        reason: `权限受限：当前身份为【${role}】，正文草稿起草、直接编辑、采纳修改与版本恢复仅允许“主笔甲”操作。`,
      };

    case 'resolve_comment':
      if (role === '主笔甲') return { allowed: true };
      return {
        allowed: false,
        reason: `权限受限：当前身份为【${role}】，仅“主笔甲”可裁决处理意见与落实修改。`,
      };

    case 'finalize':
      if (role === '主笔甲') return { allowed: true };
      return {
        allowed: false,
        reason: `权限受限：当前身份为【${role}】，定稿锁定公文仅允许“主笔甲”执行。`,
      };

    case 'add_comment':
      if (role === '主笔甲' || role === '审阅乙' || role === '审阅丁') return { allowed: true };
      return {
        allowed: false,
        reason: `权限受限：当前身份为【${role}】，供稿人员仅支持提交材料与补充说明，不可作为审阅人发表批注。`,
      };

    case 'submit_material':
    case 'supplement_fact':
      if (role === '主笔甲' || role === '供稿丙') return { allowed: true };
      return {
        allowed: false,
        reason: `权限受限：当前身份为【${role}】，审阅人不可登记材料，仅“主笔甲”与“供稿丙”可提交补充材料。`,
      };

    default:
      return { allowed: true };
  }
}

export function canEditDraft(role: UserRole): boolean {
  return role === '主笔甲';
}

export function canConfirmFacts(role: UserRole): boolean {
  return role === '主笔甲';
}

export function canConfirmStyle(role: UserRole): boolean {
  return role === '主笔甲';
}

export function canConfirmOutline(role: UserRole): boolean {
  return role === '主笔甲';
}

export function canRestoreVersion(role: UserRole): boolean {
  return role === '主笔甲';
}

export function canFinalize(role: UserRole): boolean {
  return role === '主笔甲';
}

export function canResolveComments(role: UserRole): boolean {
  return role === '主笔甲';
}

export function canSubmitMaterial(role: UserRole): boolean {
  return role === '主笔甲' || role === '供稿丙';
}

export function canAddComment(role: UserRole): boolean {
  return role === '主笔甲' || role === '审阅乙' || role === '审阅丁';
}
