// Honest inventory of VISUAL differences by role in the frontend. Today there are none:
//   - the backend knows ADMIN and SUPER_ADMIN, and every admin endpoint accepts both (@Roles(ADMIN, SUPER_ADMIN));
//     SUPER_ADMIN only differs in tenant scoping (it must name a business), which has no UI yet;
//   - no component reads user.role.
// When the first role-dependent element appears, list it here and read useViewAs().effectiveViewRole in that
// component only; the toolbar stops showing its "no differences yet" notice by itself.
export const ROLE_VISUAL_DIFFERENCES = []
