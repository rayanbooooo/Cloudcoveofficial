-- Apple Wallet membership cards for The Private Guest List.
--
-- Each membership gets one Wallet pass. When anything shown on the card changes
-- (tier, visits, a birthday treat becoming available) the pass is marked updated and
-- queued for a push, so the guest's iPhone fetches the new card and shows the change
-- on the lock screen.
--
-- These tables are only touched by edge functions running with the service role,
-- so RLS is enabled with no policies.

alter table venues
  add column latitude  numeric(9, 6),
  add column longitude numeric(9, 6);

create table wallet_passes (
  serial        text primary key default encode(gen_random_bytes(12), 'hex'),
  membership_id uuid not null unique references memberships(id) on delete cascade,
  auth_token    text not null default encode(gen_random_bytes(24), 'hex'),  -- Apple requires 16+ characters
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

-- Devices that added the pass, registered through Apple's PassKit web service.
create table wallet_registrations (
  device_library_id text not null,
  push_token        text not null,
  serial            text not null references wallet_passes(serial) on delete cascade,
  created_at        timestamptz not null default now(),
  primary key (device_library_id, serial)
);
create index wallet_registrations_serial on wallet_registrations (serial);

create table wallet_push_queue (
  id         bigint generated always as identity primary key,
  serial     text not null references wallet_passes(serial) on delete cascade,
  reason     text not null,
  created_at timestamptz not null default now(),
  sent_at    timestamptz
);
create index wallet_push_pending on wallet_push_queue (created_at) where sent_at is null;

alter table wallet_passes        enable row level security;
alter table wallet_registrations enable row level security;
alter table wallet_push_queue    enable row level security;

-- ---------------------------------------------------------------------------
-- Keep cards current
-- ---------------------------------------------------------------------------
create function touch_wallet_pass(p_membership uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  s text;
begin
  update wallet_passes set updated_at = now() where membership_id = p_membership returning serial into s;
  if s is not null then
    insert into wallet_push_queue (serial, reason) values (s, p_reason);
  end if;
end $$;

create function memberships_wallet_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.tier is distinct from old.tier then
    perform touch_wallet_pass(new.id, 'tier:' || new.tier);
  elsif new.visits is distinct from old.visits then
    perform touch_wallet_pass(new.id, 'visits');
  end if;
  return new;
end $$;

create trigger memberships_wallet after update of tier, visits on memberships
for each row execute function memberships_wallet_touch();

create function vouchers_wallet_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'birthday' and (tg_op = 'INSERT' or new.redeemed_at is distinct from old.redeemed_at) then
    perform touch_wallet_pass(new.membership_id, case when tg_op = 'INSERT' then 'birthday:ready' else 'birthday:used' end);
  end if;
  return new;
end $$;

create trigger vouchers_wallet after insert or update of redeemed_at on vouchers
for each row execute function vouchers_wallet_touch();

-- ---------------------------------------------------------------------------
-- Guest joins a venue from the QR code (called by the `join` edge function)
-- ---------------------------------------------------------------------------
-- Returns the membership, the welcome drink voucher (first join only) and the Wallet pass keys.
-- Joining again with the same phone at the same venue returns the existing membership
-- and no second welcome drink.
create function join_venue(
  p_venue_slug     text,
  p_phone          text,
  p_first_name     text,
  p_birthday_day   smallint,
  p_birthday_month smallint,
  p_interests      text[],
  p_opt_in         boolean,
  p_consent_text   text,
  p_source         text,
  p_language       text default 'en'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v        venues%rowtype;
  g_id     uuid;
  m        memberships%rowtype;
  is_new   boolean := false;
  vch      vouchers%rowtype;
  w        wallet_passes%rowtype;
  prefix   text;
  attempt  int;
begin
  select * into v from venues where slug = p_venue_slug and active;
  if not found then
    raise exception 'Unknown venue %', p_venue_slug using errcode = 'P0002';
  end if;

  insert into guests (phone_e164, first_name, birthday_day, birthday_month, language)
  values (p_phone, initcap(trim(p_first_name)), p_birthday_day, p_birthday_month, coalesce(p_language, 'en'))
  on conflict (phone_e164) do update
     set birthday_day   = coalesce(guests.birthday_day, excluded.birthday_day),
         birthday_month = coalesce(guests.birthday_month, excluded.birthday_month)
  returning id into g_id;

  select * into m from memberships where venue_id = v.id and guest_id = g_id;
  if not found then
    is_new := true;
    for attempt in 1..10 loop
      begin
        insert into memberships (venue_id, guest_id, member_no, interests, marketing_opt_in, source)
        values (v.id, g_id,
                lpad((floor(random() * 10000))::int::text, 4, '0') || ' ' || lpad((floor(random() * 100))::int::text, 2, '0'),
                coalesce(p_interests, '{}'), coalesce(p_opt_in, false), p_source)
        returning * into m;
        exit;
      exception when unique_violation then
        if attempt = 10 then raise; end if;
      end;
    end loop;

    insert into consent_log (membership_id, granted, wording) values (m.id, coalesce(p_opt_in, false), p_consent_text);

    prefix := upper(left(regexp_replace(v.name, '[^A-Za-z]', '', 'g') || 'XX', 2));
    for attempt in 1..20 loop
      begin
        insert into vouchers (venue_id, membership_id, kind, code, expires_at)
        values (v.id, m.id, 'welcome', prefix || '-' || lpad((floor(random() * 10000))::int::text, 4, '0'), now() + interval '30 minutes')
        returning * into vch;
        exit;
      exception when unique_violation then
        if attempt = 20 then raise; end if;
      end;
    end loop;
  end if;

  insert into wallet_passes (membership_id) values (m.id)
  on conflict (membership_id) do nothing;
  select * into w from wallet_passes where membership_id = m.id;

  return jsonb_build_object(
    'new_member', is_new,
    'membership_id', m.id,
    'member_no', m.member_no,
    'tier', m.tier,
    'visits', m.visits,
    'voucher', case when vch.id is null then null
                    else jsonb_build_object('code', vch.code, 'expires_at', vch.expires_at) end,
    'wallet', jsonb_build_object('serial', w.serial, 'token', w.auth_token)
  );
end $$;

revoke all on function join_venue(text, text, text, smallint, smallint, text[], boolean, text, text, text) from public, anon, authenticated;
revoke all on function touch_wallet_pass(uuid, text) from public, anon, authenticated;
grant execute on function join_venue(text, text, text, smallint, smallint, text[], boolean, text, text, text) to service_role;
