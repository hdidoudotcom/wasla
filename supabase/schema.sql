-- Wasla: automatic Instagram replies for several businesses.
-- Every business is a "workspace". People join a workspace as members; every row of business data carries
-- workspace_id and Row Level Security only shows a member the rows of their own workspaces.
-- Instagram access tokens live in a table that only the server (service role) can read.
begin;

-- Workspaces and members -------------------------------------------------------------------------
create table if not exists public.workspaces(
 id uuid primary key default gen_random_uuid(),
 name text not null check(length(trim(name)) between 2 and 80),
 created_by uuid not null,
 created_at timestamptz not null default now()
);
create table if not exists public.workspace_members(
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 user_id uuid not null,
 role text not null default 'agent' check(role in ('owner','admin','agent')),
 created_at timestamptz not null default now(),
 primary key(workspace_id,user_id)
);
create index if not exists workspace_members_user on public.workspace_members(user_id);

create or replace function public.wasla_is_member(p_workspace uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.workspace_members where workspace_id=p_workspace and user_id=auth.uid())$$;
create or replace function public.wasla_is_manager(p_workspace uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.workspace_members where workspace_id=p_workspace and user_id=auth.uid() and role in ('owner','admin'))$$;

-- A signed-in person creates a business; they become its owner.
create or replace function public.wasla_create_workspace(p_name text) returns uuid
language plpgsql security definer set search_path='' as $$
declare v uuid;
begin
 if auth.uid() is null then raise exception 'not_signed_in';end if;
 if length(trim(coalesce(p_name,''))) not between 2 and 80 then raise exception 'invalid_name';end if;
 if (select count(*) from public.workspace_members where user_id=auth.uid() and role='owner')>=10 then raise exception 'too_many_workspaces';end if;
 insert into public.workspaces(name,created_by) values(trim(p_name),auth.uid()) returning id into v;
 insert into public.workspace_members(workspace_id,user_id,role) values(v,auth.uid(),'owner');
 insert into public.workspace_settings(workspace_id) values(v);
 return v;
end$$;

-- Settings a manager can change (no secrets here) -------------------------------------------------
create table if not exists public.workspace_settings(
 workspace_id uuid primary key references public.workspaces(id) on delete cascade,
 auto_reply_dm boolean not null default true,
 auto_reply_comments boolean not null default true,
 -- after a team member writes to a contact, automatic replies stay quiet for this many minutes
 human_pause_minutes int not null default 120 check(human_pause_minutes between 0 and 10080),
 updated_at timestamptz not null default now()
);

-- Connected Instagram account: public part (members can read) and secret part (server only) ---------
create table if not exists public.instagram_accounts(
 workspace_id uuid primary key references public.workspaces(id) on delete cascade,
 ig_user_id text not null unique check(ig_user_id ~ '^[0-9]{1,30}$'),
 username text not null default '',
 status text not null default 'connected' check(status in ('connected','expired','disconnected')),
 token_expires_at timestamptz,
 connected_by uuid,
 connected_at timestamptz not null default now(),
 last_event_at timestamptz
);
create table if not exists public.instagram_tokens(
 workspace_id uuid primary key references public.instagram_accounts(workspace_id) on delete cascade,
 access_token text not null,
 refreshed_at timestamptz not null default now()
);

-- Contacts and messages ----------------------------------------------------------------------------
create table if not exists public.contacts(
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 igsid text not null check(igsid ~ '^[0-9]{1,30}$'),
 username text not null default '',
 name text not null default '',
 last_text text not null default '',
 last_message_at timestamptz not null default now(),
 last_customer_at timestamptz,
 last_staff_at timestamptz,
 unread_count int not null default 0 check(unread_count>=0),
 note text not null default '' check(length(note)<=500),
 created_at timestamptz not null default now(),
 unique(workspace_id,igsid)
);
create index if not exists contacts_recent on public.contacts(workspace_id,last_message_at desc);
create table if not exists public.messages(
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 contact_id uuid not null references public.contacts(id) on delete cascade,
 mid text,
 direction text not null check(direction in ('in','out')),
 -- customer: written by the customer; auto: a rule; staff: sent from Wasla; instagram_app: sent from the Instagram app
 sender text not null check(sender in ('customer','auto','staff','instagram_app')),
 body text not null default '' check(length(body)<=2000),
 kind text not null default 'text' check(kind in ('text','attachment','comment','unsupported')),
 rule_id uuid,
 sent_by uuid,
 created_at timestamptz not null default now(),
 unique(workspace_id,mid)
);
create index if not exists messages_thread on public.messages(contact_id,created_at);

-- Automatic reply rules ----------------------------------------------------------------------------
create table if not exists public.rules(
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 name text not null default '' check(length(name)<=80),
 -- dm: a private message; comment: a comment under a post or reel (answered by one private message)
 kind text not null check(kind in ('dm','comment')),
 -- empty list = answer every message/comment that no other rule matched
 keywords text[] not null default '{}' check(cardinality(keywords)<=30),
 reply text not null check(length(trim(reply)) between 1 and 1000),
 public_reply text not null default '' check(length(public_reply)<=300),
 media_id text check(media_id is null or media_id ~ '^[0-9]{1,30}$'),
 is_active boolean not null default true,
 position int not null default 0,
 uses int not null default 0,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index if not exists rules_order on public.rules(workspace_id,kind,position);

-- One private reply per comment (Instagram rule), recorded by the server.
create table if not exists public.comment_replies(
 comment_id text primary key,
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 rule_id uuid,
 state text not null default 'sending' check(state in ('sending','sent','failed')),
 error text,
 created_at timestamptz not null default now()
);

-- Short technical log so a business can see that events arrive (kept 14 days).
create table if not exists public.event_log(
 id bigint generated always as identity primary key,
 workspace_id uuid references public.workspaces(id) on delete cascade,
 kind text not null,
 ok boolean not null,
 detail text not null default '' check(length(detail)<=300),
 created_at timestamptz not null default now()
);
create index if not exists event_log_recent on public.event_log(workspace_id,created_at desc);

-- Called by the server for every incoming or echoed message: saves the contact and the message once.
create or replace function public.wasla_record_message(p_workspace uuid,p_igsid text,p_mid text,p_direction text,p_sender text,p_body text,p_kind text,p_at timestamptz,p_rule uuid default null,p_sent_by uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.contacts;m uuid;
begin
 insert into public.contacts(workspace_id,igsid) values(p_workspace,p_igsid) on conflict(workspace_id,igsid) do nothing;
 select * into c from public.contacts where workspace_id=p_workspace and igsid=p_igsid for update;
 insert into public.messages(workspace_id,contact_id,mid,direction,sender,body,kind,rule_id,sent_by,created_at)
 values(p_workspace,c.id,p_mid,p_direction,p_sender,left(coalesce(p_body,''),2000),p_kind,p_rule,p_sent_by,coalesce(p_at,now()))
 on conflict(workspace_id,mid) do nothing returning id into m;
 if m is null then return jsonb_build_object('contact_id',c.id,'duplicate',true);end if;
 update public.contacts set
  last_text=left(coalesce(p_body,''),200),
  last_message_at=greatest(last_message_at,coalesce(p_at,now())),
  last_customer_at=case when p_direction='in' and p_kind<>'comment' then greatest(coalesce(last_customer_at,'-infinity'),coalesce(p_at,now())) else last_customer_at end,
  last_staff_at=case when p_sender in ('staff','instagram_app') then greatest(coalesce(last_staff_at,'-infinity'),coalesce(p_at,now())) else last_staff_at end,
  unread_count=case when p_direction='in' then unread_count+1 else unread_count end
 where id=c.id;
 if p_rule is not null then update public.rules set uses=uses+1 where id=p_rule and workspace_id=p_workspace;end if;
 return jsonb_build_object('contact_id',c.id,'duplicate',false,'message_id',m,'username',c.username);
end$$;

-- A member opens a conversation.
create or replace function public.wasla_mark_read(p_contact uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 update public.contacts set unread_count=0 where id=p_contact and public.wasla_is_member(workspace_id);
end$$;

-- Row Level Security ---------------------------------------------------------------------------------
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_settings enable row level security;
alter table public.instagram_accounts enable row level security;
alter table public.instagram_tokens enable row level security;
alter table public.contacts enable row level security;
alter table public.messages enable row level security;
alter table public.rules enable row level security;
alter table public.comment_replies enable row level security;
alter table public.event_log enable row level security;

revoke all on all tables in schema public from public,anon,authenticated;
grant all on all tables in schema public to service_role;
grant select on public.workspaces,public.workspace_members,public.workspace_settings,public.instagram_accounts,public.contacts,public.messages,public.rules,public.event_log to authenticated;
grant update(auto_reply_dm,auto_reply_comments,human_pause_minutes,updated_at) on public.workspace_settings to authenticated;
grant update(note) on public.contacts to authenticated;
grant insert,update,delete on public.rules to authenticated;
-- instagram_tokens and comment_replies: server only (no grant to authenticated).

drop policy if exists ws_read on public.workspaces;
create policy ws_read on public.workspaces for select to authenticated using(public.wasla_is_member(id));
drop policy if exists members_read on public.workspace_members;
create policy members_read on public.workspace_members for select to authenticated using(public.wasla_is_member(workspace_id));
drop policy if exists settings_read on public.workspace_settings;
create policy settings_read on public.workspace_settings for select to authenticated using(public.wasla_is_member(workspace_id));
drop policy if exists settings_write on public.workspace_settings;
create policy settings_write on public.workspace_settings for update to authenticated using(public.wasla_is_manager(workspace_id)) with check(public.wasla_is_manager(workspace_id));
drop policy if exists ig_read on public.instagram_accounts;
create policy ig_read on public.instagram_accounts for select to authenticated using(public.wasla_is_member(workspace_id));
drop policy if exists contacts_read on public.contacts;
create policy contacts_read on public.contacts for select to authenticated using(public.wasla_is_member(workspace_id));
drop policy if exists contacts_note on public.contacts;
create policy contacts_note on public.contacts for update to authenticated using(public.wasla_is_member(workspace_id)) with check(public.wasla_is_member(workspace_id));
drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages for select to authenticated using(public.wasla_is_member(workspace_id));
drop policy if exists rules_read on public.rules;
create policy rules_read on public.rules for select to authenticated using(public.wasla_is_member(workspace_id));
drop policy if exists rules_write on public.rules;
create policy rules_write on public.rules for all to authenticated using(public.wasla_is_manager(workspace_id)) with check(public.wasla_is_manager(workspace_id));
drop policy if exists log_read on public.event_log;
create policy log_read on public.event_log for select to authenticated using(public.wasla_is_member(workspace_id));

revoke all on function public.wasla_record_message(uuid,text,text,text,text,text,text,timestamptz,uuid,uuid) from public,anon,authenticated;
grant execute on function public.wasla_record_message(uuid,text,text,text,text,text,text,timestamptz,uuid,uuid) to service_role;
revoke all on function public.wasla_create_workspace(text) from public,anon;
grant execute on function public.wasla_create_workspace(text) to authenticated;
revoke all on function public.wasla_mark_read(uuid) from public,anon;
grant execute on function public.wasla_mark_read(uuid) to authenticated;
revoke all on function public.wasla_is_member(uuid),public.wasla_is_manager(uuid) from public,anon;
grant execute on function public.wasla_is_member(uuid),public.wasla_is_manager(uuid) to authenticated,service_role;
commit;
