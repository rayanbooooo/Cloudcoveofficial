-- The Private Guest List: multi-tenant schema for white-label venue members apps.
--
-- One codebase, many venues. Each venue sees only its own members.
-- A guest has ONE identity (guests) across venues and a separate membership per venue,
-- so a cross-venue programme can be switched on later without a rebuild.
--
-- Access model:
--   * Venue staff sign in with Supabase Auth and are linked to venues through venue_staff.
--   * Guests do not get direct table access. The guest-facing app talks to edge functions
--     that run with the service role (join, claim voucher, book, RSVP).
--   * Staff actions that must be atomic (redeeming a voucher) go through security definer functions.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type venue_type   as enum ('beach', 'dining', 'lounge');
create type staff_role   as enum ('owner', 'manager', 'staff');
create type member_tier  as enum ('silver', 'gold', 'black');
create type voucher_kind as enum ('welcome', 'birthday', 'comeback', 'event');
create type visit_source as enum ('voucher', 'booking', 'checkin');
create type booking_status as enum ('requested', 'confirmed', 'seated', 'cancelled', 'no_show');
create type message_status as enum ('scheduled', 'sent', 'delivered', 'read', 'failed', 'skipped');

-- ---------------------------------------------------------------------------
-- Venues and staff
-- ---------------------------------------------------------------------------
create table venues (
  id                 uuid primary key default gen_random_uuid(),
  slug               text not null unique check (slug ~ '^[a-z0-9-]{2,40}$'),
  name               text not null,
  area               text,
  type               venue_type not null default 'dining',
  theme              text not null default 'gold',
  timezone           text not null default 'Asia/Dubai',
  welcome_drink_text text not null default 'A welcome drink, on the house',
  tier_gold_at       int  not null default 3 check (tier_gold_at > 0),
  tier_black_at      int  not null default 6,
  guarantee_target   int,                     -- returning guests promised in the contract
  guarantee_ends_on  date,
  whatsapp_number    text,                    -- the venue's WhatsApp Business sender
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  check (tier_black_at > tier_gold_at)
);

create table venue_staff (
  venue_id   uuid not null references venues(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       staff_role not null default 'staff',
  created_at timestamptz not null default now(),
  primary key (venue_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Guests (one identity) and memberships (one per venue)
-- ---------------------------------------------------------------------------
create table guests (
  id             uuid primary key default gen_random_uuid(),
  phone_e164     text not null unique check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  first_name     text not null,
  birthday_day   smallint check (birthday_day between 1 and 31),
  birthday_month smallint check (birthday_month between 1 and 12),
  language       text not null default 'en' check (language in ('en', 'ar', 'ru', 'fr', 'nl')),
  created_at     timestamptz not null default now()
);

create table memberships (
  id               uuid primary key default gen_random_uuid(),
  venue_id         uuid not null references venues(id) on delete cascade,
  guest_id         uuid not null references guests(id) on delete cascade,
  member_no        text not null,
  tier             member_tier not null default 'silver',
  visits           int not null default 0,
  interests        text[] not null default '{}',
  marketing_opt_in boolean not null default false,
  source           text,                       -- e.g. 'qr:table-12', 'booking-page'
  joined_at        timestamptz not null default now(),
  last_visit_at    timestamptz,
  unique (venue_id, guest_id),
  unique (venue_id, member_no)
);
create index memberships_venue_last_visit on memberships (venue_id, last_visit_at);

-- Audit trail for marketing consent (UAE PDPL / GDPR): what was shown, when, and the answer.
create table consent_log (
  id            bigint generated always as identity primary key,
  membership_id uuid not null references memberships(id) on delete cascade,
  granted       boolean not null,
  channel       text not null default 'whatsapp',
  wording       text not null,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Vouchers, visits, bookings, events
-- ---------------------------------------------------------------------------
create table vouchers (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues(id) on delete cascade,
  membership_id uuid not null references memberships(id) on delete cascade,
  kind          voucher_kind not null,
  code          text not null,
  issued_at     timestamptz not null default now(),
  expires_at    timestamptz not null,
  redeemed_at   timestamptz,
  redeemed_by   uuid references auth.users(id),
  unique (venue_id, code)
);
-- One welcome drink per guest per venue, ever.
create unique index one_welcome_per_member on vouchers (membership_id) where kind = 'welcome';

create table visits (
  id            bigint generated always as identity primary key,
  venue_id      uuid not null references venues(id) on delete cascade,
  membership_id uuid not null references memberships(id) on delete cascade,
  source        visit_source not null,
  voucher_id    uuid references vouchers(id),
  spend_aed     numeric(10, 2),               -- filled when the till is connected, for revenue tracking
  visited_at    timestamptz not null default now()
);
create index visits_venue_time on visits (venue_id, visited_at);

create table bookings (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues(id) on delete cascade,
  membership_id uuid not null references memberships(id) on delete cascade,
  starts_at     timestamptz not null,
  party_size    smallint not null check (party_size between 1 and 30),
  status        booking_status not null default 'requested',
  priority      boolean not null default false,  -- Gold and Black members skip the waitlist
  notes         text,
  created_at    timestamptz not null default now()
);
create index bookings_venue_start on bookings (venue_id, starts_at);

create table events (
  id                 uuid primary key default gen_random_uuid(),
  venue_id           uuid not null references venues(id) on delete cascade,
  title              text not null,
  subtitle           text,
  starts_at          timestamptz not null,
  capacity           int,
  members_only_until timestamptz,             -- members get first access until this time
  created_at         timestamptz not null default now()
);

create table rsvps (
  event_id      uuid not null references events(id) on delete cascade,
  membership_id uuid not null references memberships(id) on delete cascade,
  status        text not null default 'requested' check (status in ('requested', 'confirmed', 'declined')),
  created_at    timestamptz not null default now(),
  primary key (event_id, membership_id)
);

-- Every automated WhatsApp message: scheduled by the automation worker, updated by the WhatsApp webhook.
create table messages (
  id             bigint generated always as identity primary key,
  venue_id       uuid not null references venues(id) on delete cascade,
  membership_id  uuid not null references memberships(id) on delete cascade,
  automation     text not null check (automation in ('welcome', 'birthday', 'review_request', 'comeback', 'vip_alert', 'booking_reminder', 'campaign')),
  template       text not null,
  status         message_status not null default 'scheduled',
  scheduled_for  timestamptz not null,
  sent_at        timestamptz,
  wa_message_id  text,
  error          text,
  created_at     timestamptz not null default now()
);
create index messages_due on messages (status, scheduled_for) where status = 'scheduled';
-- Never send the same automation twice for the same guest on the same day.
create unique index messages_once_per_day on messages (membership_id, automation, ((scheduled_for at time zone 'UTC')::date));

-- ---------------------------------------------------------------------------
-- Tier upkeep: every visit bumps the counter and recalculates the tier
-- ---------------------------------------------------------------------------
create function apply_visit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v venues%rowtype;
  n int;
begin
  select * into v from venues where id = new.venue_id;
  update memberships
     set visits = visits + 1,
         last_visit_at = greatest(coalesce(last_visit_at, new.visited_at), new.visited_at)
   where id = new.membership_id
   returning visits into n;
  update memberships
     set tier = case when n >= v.tier_black_at then 'black'::member_tier
                     when n >= v.tier_gold_at  then 'gold'::member_tier
                     else 'silver'::member_tier end
   where id = new.membership_id;
  return new;
end $$;

create trigger visits_apply after insert on visits
for each row execute function apply_visit();

-- ---------------------------------------------------------------------------
-- Access helpers and row level security
-- ---------------------------------------------------------------------------
create function is_venue_staff(v uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from venue_staff where venue_id = v and user_id = auth.uid());
$$;

create function is_venue_manager(v uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from venue_staff where venue_id = v and user_id = auth.uid() and role in ('owner', 'manager'));
$$;

alter table venues      enable row level security;
alter table venue_staff enable row level security;
alter table guests      enable row level security;
alter table memberships enable row level security;
alter table consent_log enable row level security;
alter table vouchers    enable row level security;
alter table visits      enable row level security;
alter table bookings    enable row level security;
alter table events      enable row level security;
alter table rsvps       enable row level security;
alter table messages    enable row level security;

create policy "staff read own venues"   on venues for select to authenticated using (is_venue_staff(id));
create policy "managers edit own venue" on venues for update to authenticated using (is_venue_manager(id)) with check (is_venue_manager(id));

create policy "staff see their team" on venue_staff for select to authenticated using (is_venue_staff(venue_id));

-- Staff see a guest only if that guest is a member of one of their venues.
-- They never see the guest's memberships at other venues.
create policy "staff read member guests" on guests for select to authenticated
  using (exists (select 1 from memberships m where m.guest_id = guests.id and is_venue_staff(m.venue_id)));

create policy "staff read memberships"   on memberships for select to authenticated using (is_venue_staff(venue_id));
create policy "staff read consent"       on consent_log for select to authenticated
  using (exists (select 1 from memberships m where m.id = consent_log.membership_id and is_venue_staff(m.venue_id)));
create policy "staff read vouchers"      on vouchers   for select to authenticated using (is_venue_staff(venue_id));
create policy "staff read visits"        on visits     for select to authenticated using (is_venue_staff(venue_id));
create policy "staff log visits"         on visits     for insert to authenticated with check (is_venue_staff(venue_id));
create policy "staff manage bookings"    on bookings   for all    to authenticated using (is_venue_staff(venue_id)) with check (is_venue_staff(venue_id));
create policy "staff read events"        on events     for select to authenticated using (is_venue_staff(venue_id));
create policy "managers manage events"   on events     for all    to authenticated using (is_venue_manager(venue_id)) with check (is_venue_manager(venue_id));
create policy "staff manage rsvps"       on rsvps      for all    to authenticated
  using (exists (select 1 from events e where e.id = rsvps.event_id and is_venue_staff(e.venue_id)))
  with check (exists (select 1 from events e where e.id = rsvps.event_id and is_venue_staff(e.venue_id)));
create policy "staff read messages"      on messages   for select to authenticated using (is_venue_staff(venue_id));

-- ---------------------------------------------------------------------------
-- Staff action: redeem a voucher by code (bar tablet)
-- ---------------------------------------------------------------------------
create function redeem_voucher(p_venue uuid, p_code text)
returns table (voucher_id uuid, kind voucher_kind, first_name text, tier member_tier, visits int)
language plpgsql security definer set search_path = public as $$
declare
  vch vouchers%rowtype;
begin
  if not is_venue_staff(p_venue) then
    raise exception 'not staff at this venue' using errcode = '42501';
  end if;

  select * into vch from vouchers
   where venue_id = p_venue and code = upper(trim(p_code))
   for update;

  if not found then
    raise exception 'No voucher with code %', upper(trim(p_code)) using errcode = 'P0002';
  elsif vch.redeemed_at is not null then
    raise exception 'Voucher % was already redeemed', vch.code using errcode = 'P0001';
  elsif vch.expires_at < now() then
    raise exception 'Voucher % has expired', vch.code using errcode = 'P0001';
  end if;

  update vouchers set redeemed_at = now(), redeemed_by = auth.uid() where id = vch.id;
  insert into visits (venue_id, membership_id, source, voucher_id) values (p_venue, vch.membership_id, 'voucher', vch.id);

  return query
    select vch.id, vch.kind, g.first_name, m.tier, m.visits
      from memberships m join guests g on g.id = m.guest_id
     where m.id = vch.membership_id;
end $$;

revoke all on function redeem_voucher(uuid, text) from public, anon;
grant execute on function redeem_voucher(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Owner dashboard: headline numbers, including progress against the guarantee
-- ---------------------------------------------------------------------------
create view venue_stats with (security_invoker = true) as
select
  v.id as venue_id,
  (select count(*) from memberships m where m.venue_id = v.id) as members,
  (select count(*) from memberships m where m.venue_id = v.id and m.marketing_opt_in) as opted_in,
  (select count(*) from memberships m where m.venue_id = v.id and m.visits >= 2) as returning_members,
  (select count(*) from memberships m where m.venue_id = v.id and m.tier = 'gold') as gold,
  (select count(*) from memberships m where m.venue_id = v.id and m.tier = 'black') as black,
  (select count(*) from visits x where x.venue_id = v.id and x.visited_at > now() - interval '30 days') as visits_30d,
  v.guarantee_target,
  v.guarantee_ends_on
from venues v;
