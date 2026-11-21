-- 0001 declares search_path = '' on both functions, but the live database had
-- neither setting (Supabase advisor 0011_function_search_path_mutable). Both
-- bodies already schema-qualify every reference, so pinning is behaviour-neutral.
alter function public.touch_user_profile() set search_path = '';
alter function public.commit_user_profile(bigint, jsonb) set search_path = '';
