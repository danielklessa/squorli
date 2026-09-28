--
-- PostgreSQL database dump
--

\restrict FEPxzt1MMDk36yL4tNrXZ39HALW1VwkH2rPDkI0eI6S5uiNA0J730coMxK6yh0w

-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: drizzle; Type: SCHEMA; Schema: -; Owner: chat
--

CREATE SCHEMA drizzle;


ALTER SCHEMA drizzle OWNER TO chat;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: __drizzle_migrations; Type: TABLE; Schema: drizzle; Owner: chat
--

CREATE TABLE drizzle.__drizzle_migrations (
    id integer NOT NULL,
    hash text NOT NULL,
    created_at bigint
);


ALTER TABLE drizzle.__drizzle_migrations OWNER TO chat;

--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE; Schema: drizzle; Owner: chat
--

CREATE SEQUENCE drizzle.__drizzle_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNER TO chat;

--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: drizzle; Owner: chat
--

ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNED BY drizzle.__drizzle_migrations.id;


--
-- Name: attachments; Type: TABLE; Schema: public; Owner: chat
--

CREATE TABLE public.attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id uuid,
    uploader_id uuid NOT NULL,
    name text NOT NULL,
    size integer NOT NULL,
    mime_type text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.attachments OWNER TO chat;

--
-- Name: bans; Type: TABLE; Schema: public; Owner: chat
--

CREATE TABLE public.bans (
    user_id uuid NOT NULL,
    banned_by uuid,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.bans OWNER TO chat;

--
-- Name: categories; Type: TABLE; Schema: public; Owner: chat
--

CREATE TABLE public.categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    "position" integer DEFAULT 0 NOT NULL
);


ALTER TABLE public.categories OWNER TO chat;

--
-- Name: category_overwrites; Type: TABLE; Schema: public; Owner: chat
--

CREATE TABLE public.category_overwrites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    category_id uuid NOT NULL,
    role_id uuid,
    user_id uuid,
    allow integer DEFAULT 0 NOT NULL,
    deny integer DEFAULT 0 NOT NULL,
    CONSTRAINT category_overwrites_one_target CHECK (((role_id IS NULL) <> (user_id IS NULL)))
);


ALTER TABLE public.category_overwrites OWNER TO chat;

--
-- Name: channel_blocks; Type: TABLE; Schema: public; Owner: chat
--

CREATE TABLE public.channel_blocks (
    channel_id uuid NOT NULL,
    user_id uuid NOT NULL,
    until timestamp with time zone,
    source text NOT NULL,
    blocked_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.channel_blocks OWNER TO chat;

--
-- Name: channel_mutes; Type: TABLE; Schema: public; Owner: chat
--

CREATE TABLE public.channel_mutes (
    user_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.channel_mutes OWNER TO chat;

--
-- Name: channel_overwrites; Type: TABLE; Schema: public; Owner: chat
--

CREATE TABLE public.channel_overwrites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel_id uuid NOT NULL,
    role_id uuid,
    user_id uuid,
    allow integer DEFAULT 0 NOT NULL,
    deny integer DEFAULT 0 NOT NULL,
    CONSTRAINT channel_overwrites_one_target CHECK (((role_id IS NULL) <> (user_id IS NULL)))
);


ALTER TABLE public.channel_overwrites OWNER TO chat;

--
-- Name: channels; Type: TABLE; Schema: public; Owner: chat
--

CREATE TABLE public.channels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    topic text,
    category_id uuid,
    "position" integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    audio_bitrate integer DEFAULT 64 NOT NULL,
    audio_stereo boolean DEFAULT false NOT NULL,
    radio_station_id uuid,
    radio_stream_url text,
    radio_started_by uuid,
    radio_name text,
    radio_playback jsonb,
    radio_queue jsonb,
    sticky boolean DEFAULT false NOT NULL,
    sticky_persist boolean DEFAULT false NOT NULL,
    sticky_hide_voice boolean DEFAULT true NOT NULL,
    user_limit integer,
    slowmode_seconds integer DEFAULT 0 NOT NULL,
    default_notification text DEFAULT 'all'::text NOT NULL,
    allow_radio boolean DEFAULT true NOT NULL,
    allow_video boolean DEFAULT true NOT NULL,
    allow_vote_kick boolean DEFAULT true NOT NULL
);


ALTER TABLE public.channels OWNER TO chat;

--
-- Name: invites; Type: TABLE; Schema: public; Owner: chat
--

CREATE TABLE public.invites (
    code text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    max_uses integer,
    uses integer DEFAULT 0 NOT NULL,
    revoked_at timestamp with time zone
);


ALTER TABLE public.invites OWNER TO chat;

--
-- Name: local_accounts; Type: TABLE; Schema: public; Owner: chat
--

CREATE TABLE public.local_accounts (
    user_id uuid NOT NULL,
    handle text NOT NULL,
    backup_params jsonb NOT NULL,
    ciphertext text NOT NULL,
    auth_hash text NOT NULL,
    avatar_mime text,
    avatar_updated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.local_accounts OWNER TO chat;

--
-- Name: member_roles; Type: TABLE; Schema: public; Owner: chat
--

CREATE TABLE public.member_roles (
    user_id uuid NOT NULL,
    role_id uuid NOT NULL
);


ALTER TABLE public.member_roles OWNER TO chat;

--
-- Name: members; Type: TABLE; Schema: public; Owner: chat
--

CREATE TABLE public.members (
    user_id uuid NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    stream_blocked boolean DEFAULT false NOT NULL,
    is_owner boolean DEFAULT false NOT NULL,
    muted boolean DEFAULT false NOT NULL,
    confined_channel_id uuid
);


ALTER TABLE public.members OWNER TO chat;

--
-- Name: messages; Type: TABLE; Schema: public; Owner: chat
--

CREATE TABLE public.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    seq bigint NOT NULL,
    channel_id uuid NOT NULL,
    author_id uuid NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    edited_at timestamp with time zone,
    previews jsonb
);


ALTER TABLE public.messages OWNER TO chat;

--
-- Name: messages_seq_seq; Type: SEQUENCE; Schema: public; Owner: chat
--

CREATE SEQUENCE public.messages_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.messages_seq_seq OWNER TO chat;

--
-- Name: messages_seq_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: chat
--

ALTER SEQUENCE public.messages_seq_seq OWNED BY public.messages.seq;


--
-- Name: mod_log; Type: TABLE; Schema: public; Owner: chat
--

CREATE TABLE public.mod_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    actor_id uuid,
    actor_name text NOT NULL,
    target_user_id uuid,
    target_name text,
    action text NOT NULL,
    channel_id uuid,
    channel_name text,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL
);


ALTER TABLE public.mod_log OWNER TO chat;

--
-- Name: radio_stations; Type: TABLE; Schema: public; Owner: chat
--

CREATE TABLE public.radio_stations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.radio_stations OWNER TO chat;

--
-- Name: read_states; Type: TABLE; Schema: public; Owner: chat
--

CREATE TABLE public.read_states (
    user_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    last_read_seq bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.read_states OWNER TO chat;

--
-- Name: reports; Type: TABLE; Schema: public; Owner: chat
--

CREATE TABLE public.reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    reason text NOT NULL,
    text text,
    status text DEFAULT 'open'::text NOT NULL,
    reporter_id uuid,
    reporter_name text NOT NULL,
    reported_user_id uuid,
    reported_name text NOT NULL,
    channel_id uuid,
    channel_name text,
    message_id uuid,
    snapshot jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    closed_by uuid,
    closed_by_name text,
    action text,
    note text
);


ALTER TABLE public.reports OWNER TO chat;

--
-- Name: roles; Type: TABLE; Schema: public; Owner: chat
--

CREATE TABLE public.roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    color text,
    permissions integer DEFAULT 0 NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    is_default boolean DEFAULT false NOT NULL
);


ALTER TABLE public.roles OWNER TO chat;

--
-- Name: server_settings; Type: TABLE; Schema: public; Owner: chat
--

CREATE TABLE public.server_settings (
    id text NOT NULL,
    name text NOT NULL,
    open_join boolean DEFAULT false NOT NULL,
    owner_id uuid,
    icon_mime text,
    icon_updated_at timestamp with time zone,
    directory_private_key text,
    require_account boolean DEFAULT false NOT NULL,
    listed boolean DEFAULT false NOT NULL,
    description text,
    radio_auto_stop boolean DEFAULT true NOT NULL,
    afk_channel_id uuid,
    status_api text DEFAULT 'off'::text NOT NULL,
    status_api_key text,
    status_api_role_id uuid,
    local_accounts boolean DEFAULT false NOT NULL,
    link_secret text,
    refuse_suspended boolean DEFAULT true NOT NULL
);


ALTER TABLE public.server_settings OWNER TO chat;

--
-- Name: sessions; Type: TABLE; Schema: public; Owner: chat
--

CREATE TABLE public.sessions (
    token text NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    label text,
    last_used_at timestamp with time zone
);


ALTER TABLE public.sessions OWNER TO chat;

--
-- Name: users; Type: TABLE; Schema: public; Owner: chat
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    public_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    display_name text,
    handle text,
    handle_checked_at timestamp with time zone,
    avatar_url text,
    suspended_until timestamp with time zone
);


ALTER TABLE public.users OWNER TO chat;

--
-- Name: __drizzle_migrations id; Type: DEFAULT; Schema: drizzle; Owner: chat
--

ALTER TABLE ONLY drizzle.__drizzle_migrations ALTER COLUMN id SET DEFAULT nextval('drizzle.__drizzle_migrations_id_seq'::regclass);


--
-- Name: messages seq; Type: DEFAULT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.messages ALTER COLUMN seq SET DEFAULT nextval('public.messages_seq_seq'::regclass);


--
-- Data for Name: __drizzle_migrations; Type: TABLE DATA; Schema: drizzle; Owner: chat
--

COPY drizzle.__drizzle_migrations (id, hash, created_at) FROM stdin;
1	5b14a5535c3e6dbeb4af862c3df31f9be799ad95c07972ce9b7918ec8b9f5a5e	1789308646796
2	68999bf6c9a61897d1cf107acc6d7300a32efa89ca7b1eb0021aa6e04b6d4e1c	1789312045470
3	bea8cf721d0fd9e20b914912cd305b0e15b5578ac37d9dc0dd1aca2b01a22bca	1789316603873
4	89377a3154924c58064e1789458e38713a962d86218e1d5facf63ab578233cde	1789319185440
5	f4862b03348a178dc8242c7d5e39712af4cb88ebaf8d91de846e1104b8751a77	1789319789407
6	6be5483f518426b214311e21b40269ad2f55bb9c034261acc12ddb73c98f6073	1789321252175
7	75008fca92d0890b7e50f266b6c2fabee3b1fb1af301b14ce30ff000070fcfdb	1789330339014
8	bc554421af84b51cd7b569a6e0819e65c4b9e4bda89d774edc847ecbf75a1015	1789338105542
9	bb3046221677fcfd0490a217bc4a24527b72003294548d2dce4b47a3d42075da	1789369089713
10	15b2a47cbf4cf7c608c948bee7afeede135594b4ba75dbd4ff96109cb24f3d6c	1789376302071
11	7a849741577448199e47e7a665c71e585a40aa6bbe017beacb628f4df447b9d6	1789392016759
12	99d00d89ff4db1497b678dd7098af05b4f1596be028f70b9a8eb6ddd40fff9d0	1789399035122
13	33e84a2f2e5ae2d5efab60db1c0c8e1e4f97829dcebfd86805f053a4873a06cf	1789403776515
14	4a3c7a9f13fedd57a11e17b81b476e298651ec49d319a1b6f0476a65e2a3c71a	1789633391750
15	c0c7630dee3bf7b00eb58df65b100bc2f85dee5f329078c0732f478f12ee9e6e	1789641093084
16	d83e3ae0bdccc0753c2ca7300a5f64a5c95f840f7aeb8583e953def93fa26497	1789641097312
17	079dedc0417410bfa5fbdf4b179ed3ca82e7722e6663d3f62365be0a3d19d1aa	1789641770788
18	8847bd339c0c9d0f2309fc7db0b4496f6580a81594eace38377363abfcc0c70f	1789644686744
19	4fccf16bf99c425f9a129882ba12646dbb2894743ca34e403828d2693d6bef40	1789650183099
20	3168bcba0403cda471da2a0ea648c158f5cd0351a5904cff670032b2c04c4149	1789654388504
21	2097112d434c9ca53edf218626b2e7815882e9a03a2f9bdae4bf76dc380c55dd	1789663622431
22	47b487df98fb19fa06a6168f4b86c3f2dbbf41b628856f87175fcb7d099aa638	1789673349772
23	2cf7795b57c7572f2604a648c2417c2781f2d53b329ebe33023b1f3b9fcec382	1789819327162
24	c991c87b951dee43d7cbec60658eb80058c6c6780d3754df4248f56076492e8b	1789911413484
25	b4620f3fee653ab40cd5c867b14be3f44823dd4d35cbd1e05632dd94d5b48967	1789985127359
26	a38c10073a65fa1f3961c22d26b956dc96acce7429f642e69aad5d3e61cdd167	1790118526704
27	31e7d341ac5c7f15edf24ff7a58d20fd33e29c2c56aec57a787a51a42a8d07d7	1790119534568
28	834765c15af438e6616cbb233f77c08336a39cc3c84432e7bd3a63cd427b4675	1790153149973
29	54628195987eb60337ffe056b62d9f37449982627322290bd265c71f2dd3bfe8	1790153292221
30	0710a5d0a6d309d32c8ab0fd8925b25f16006f16f36254c2026c93437155e998	1790171835610
31	44a2cfd8c62f83301b9f31565e88ed0af8efb9f2a5d1a37317145d716c0bd955	1790174005627
32	326af8ea389df3a53f2bcf55a550c34982a010c43ad67216ce61fe5184f2831e	1790248655005
33	31a47de7b5bc5ffacb30aead06a408e163d6ad86029631fce7447d637a62cc5e	1790327876998
34	1676b2cf7ad57cf03fedc86ace64cdb4755aeb786dc24738ebcde835af3c619f	1790350258309
35	9a25a53448eb29e5a457d420e3e852ff10b68a38927fd8ce73892f454fe96d2b	1790364751118
36	302583c9aed426177064d135836898ea6ab41acc6ca9bcb6e9f043f3956cd0ae	1790374719316
37	38f50d0a73ff80daf60f281073c78453485bfa073ca330455de27c10e14b7e31	1790374768885
38	dbc403793955eea697742d0fdc5c035a0e4c40622e5b2d66fb8032a711966fa7	1790532582796
\.


--
-- Data for Name: attachments; Type: TABLE DATA; Schema: public; Owner: chat
--

COPY public.attachments (id, message_id, uploader_id, name, size, mime_type, created_at) FROM stdin;
457aa7c8-d3b8-451f-a00c-104e0ce2a2e1	506d972b-b9ed-4645-aeab-185e9fad95ed	af675626-42e8-4f72-b7c4-32a4831100e2	prüfung ü.txt	56000	text/plain	2026-09-28 10:43:58.448339+00
\.


--
-- Data for Name: bans; Type: TABLE DATA; Schema: public; Owner: chat
--

COPY public.bans (user_id, banned_by, reason, created_at) FROM stdin;
\.


--
-- Data for Name: categories; Type: TABLE DATA; Schema: public; Owner: chat
--

COPY public.categories (id, name, "position") FROM stdin;
f3cb40ae-4a02-43ec-9b9d-fcb102088ba2	Allgemein	0
\.


--
-- Data for Name: category_overwrites; Type: TABLE DATA; Schema: public; Owner: chat
--

COPY public.category_overwrites (id, category_id, role_id, user_id, allow, deny) FROM stdin;
\.


--
-- Data for Name: channel_blocks; Type: TABLE DATA; Schema: public; Owner: chat
--

COPY public.channel_blocks (channel_id, user_id, until, source, blocked_by, created_at) FROM stdin;
\.


--
-- Data for Name: channel_mutes; Type: TABLE DATA; Schema: public; Owner: chat
--

COPY public.channel_mutes (user_id, channel_id, created_at) FROM stdin;
\.


--
-- Data for Name: channel_overwrites; Type: TABLE DATA; Schema: public; Owner: chat
--

COPY public.channel_overwrites (id, channel_id, role_id, user_id, allow, deny) FROM stdin;
\.


--
-- Data for Name: channels; Type: TABLE DATA; Schema: public; Owner: chat
--

COPY public.channels (id, kind, name, topic, category_id, "position", created_at, audio_bitrate, audio_stereo, radio_station_id, radio_stream_url, radio_started_by, radio_name, radio_playback, radio_queue, sticky, sticky_persist, sticky_hide_voice, user_limit, slowmode_seconds, default_notification, allow_radio, allow_video, allow_vote_kick) FROM stdin;
558db83e-b21c-43b3-b668-71a1b38659fc	text	allgemein	Willkommen	f3cb40ae-4a02-43ec-9b9d-fcb102088ba2	0	2026-09-28 10:43:56.668916+00	64	f	\N	\N	\N	\N	\N	\N	f	f	t	\N	0	all	t	t	t
25731e4f-9a90-46f3-b7e5-43c698ad6875	voice	Lobby	\N	f3cb40ae-4a02-43ec-9b9d-fcb102088ba2	1	2026-09-28 10:43:56.668916+00	64	f	\N	\N	\N	\N	\N	\N	f	f	t	\N	0	all	t	t	t
\.


--
-- Data for Name: invites; Type: TABLE DATA; Schema: public; Owner: chat
--

COPY public.invites (code, created_by, created_at, expires_at, max_uses, uses, revoked_at) FROM stdin;
\.


--
-- Data for Name: local_accounts; Type: TABLE DATA; Schema: public; Owner: chat
--

COPY public.local_accounts (user_id, handle, backup_params, ciphertext, auth_hash, avatar_mime, avatar_updated_at, created_at, updated_at) FROM stdin;
af675626-42e8-4f72-b7c4-32a4831100e2	saa521b4beb8c	{"iv": "000000000000000000000000", "kdf": "pbkdf2-sha256", "salt": "00000000000000000000000000000000", "iterations": 100000}	v7hr2OkJEDvc3N4LFJKkC1a5VrjmfBKL+jA3AtmbnjQ=	271a413bd339c5709fdceaec41f14f11e9fbfb5042d72d331c65f32b284cd09a	\N	\N	2026-09-28 10:43:58.385067+00	2026-09-28 10:43:58.384+00
\.


--
-- Data for Name: member_roles; Type: TABLE DATA; Schema: public; Owner: chat
--

COPY public.member_roles (user_id, role_id) FROM stdin;
af675626-42e8-4f72-b7c4-32a4831100e2	fe9be407-243e-47f4-8e22-e89bb5444d1c
\.


--
-- Data for Name: members; Type: TABLE DATA; Schema: public; Owner: chat
--

COPY public.members (user_id, joined_at, stream_blocked, is_owner, muted, confined_channel_id) FROM stdin;
af675626-42e8-4f72-b7c4-32a4831100e2	2026-09-28 10:43:58.391967+00	f	t	f	\N
\.


--
-- Data for Name: messages; Type: TABLE DATA; Schema: public; Owner: chat
--

COPY public.messages (id, seq, channel_id, author_id, content, created_at, edited_at, previews) FROM stdin;
506d972b-b9ed-4645-aeab-185e9fad95ed	1	558db83e-b21c-43b3-b668-71a1b38659fc	af675626-42e8-4f72-b7c4-32a4831100e2	von Linux: Grüße aus dem Container	2026-09-28 10:43:58.466276+00	\N	\N
\.


--
-- Data for Name: mod_log; Type: TABLE DATA; Schema: public; Owner: chat
--

COPY public.mod_log (id, at, actor_id, actor_name, target_user_id, target_name, action, channel_id, channel_name, detail) FROM stdin;
\.


--
-- Data for Name: radio_stations; Type: TABLE DATA; Schema: public; Owner: chat
--

COPY public.radio_stations (id, name, url, created_at) FROM stdin;
\.


--
-- Data for Name: read_states; Type: TABLE DATA; Schema: public; Owner: chat
--

COPY public.read_states (user_id, channel_id, last_read_seq, updated_at) FROM stdin;
\.


--
-- Data for Name: reports; Type: TABLE DATA; Schema: public; Owner: chat
--

COPY public.reports (id, kind, reason, text, status, reporter_id, reporter_name, reported_user_id, reported_name, channel_id, channel_name, message_id, snapshot, created_at, closed_at, closed_by, closed_by_name, action, note) FROM stdin;
\.


--
-- Data for Name: roles; Type: TABLE DATA; Schema: public; Owner: chat
--

COPY public.roles (id, name, color, permissions, "position", is_default) FROM stdin;
93eedcc8-0810-41f7-ac8c-25adf1781076	Mitglied	#3ba55c	24000	1	f
9eb2c0bd-9638-49bf-92c6-d5f8b1e3d151	Gast	\N	1152	0	t
fe9be407-243e-47f4-8e22-e89bb5444d1c	Admin	#e67e22	1	100	f
\.


--
-- Data for Name: server_settings; Type: TABLE DATA; Schema: public; Owner: chat
--

COPY public.server_settings (id, name, open_join, owner_id, icon_mime, icon_updated_at, directory_private_key, require_account, listed, description, radio_auto_stop, afk_channel_id, status_api, status_api_key, status_api_role_id, local_accounts, link_secret, refuse_suspended) FROM stdin;
server	Linux Quelle	f	af675626-42e8-4f72-b7c4-32a4831100e2	\N	\N	40f607f13abaf068e339d8625402c6b4f549180d793b9766814f1a1169bafc58	f	f	\N	t	\N	off	\N	\N	f	240fa643c4b040c4d6448c69801caf133951563bed15195856c44ac8eac24462	t
\.


--
-- Data for Name: sessions; Type: TABLE DATA; Schema: public; Owner: chat
--

COPY public.sessions (token, user_id, created_at, expires_at, id, label, last_used_at) FROM stdin;
dd67dde16e989bef8e69134ca999c80f1068362321266125b1ca1a53a3096a3e	af675626-42e8-4f72-b7c4-32a4831100e2	2026-09-28 10:43:58.398824+00	2026-10-28 10:43:58.398+00	0fd50cff-32d9-4403-a9f7-b08840daa5d2	Browser	2026-09-28 10:43:58.398+00
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: chat
--

COPY public.users (id, public_key, created_at, last_seen_at, display_name, handle, handle_checked_at, avatar_url, suspended_until) FROM stdin;
af675626-42e8-4f72-b7c4-32a4831100e2	aa521b4beb8c0b7c0f6b62c549e18a05c3591000375d7e3711273a5b1c4bdf5f	2026-09-28 10:43:58.383588+00	\N	\N	\N	\N	\N	\N
\.


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE SET; Schema: drizzle; Owner: chat
--

SELECT pg_catalog.setval('drizzle.__drizzle_migrations_id_seq', 38, true);


--
-- Name: messages_seq_seq; Type: SEQUENCE SET; Schema: public; Owner: chat
--

SELECT pg_catalog.setval('public.messages_seq_seq', 1, true);


--
-- Name: __drizzle_migrations __drizzle_migrations_pkey; Type: CONSTRAINT; Schema: drizzle; Owner: chat
--

ALTER TABLE ONLY drizzle.__drizzle_migrations
    ADD CONSTRAINT __drizzle_migrations_pkey PRIMARY KEY (id);


--
-- Name: attachments attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);


--
-- Name: bans bans_pkey; Type: CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.bans
    ADD CONSTRAINT bans_pkey PRIMARY KEY (user_id);


--
-- Name: categories categories_pkey; Type: CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);


--
-- Name: category_overwrites category_overwrites_pkey; Type: CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.category_overwrites
    ADD CONSTRAINT category_overwrites_pkey PRIMARY KEY (id);


--
-- Name: channel_blocks channel_blocks_channel_id_user_id_pk; Type: CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.channel_blocks
    ADD CONSTRAINT channel_blocks_channel_id_user_id_pk PRIMARY KEY (channel_id, user_id);


--
-- Name: channel_mutes channel_mutes_user_id_channel_id_pk; Type: CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.channel_mutes
    ADD CONSTRAINT channel_mutes_user_id_channel_id_pk PRIMARY KEY (user_id, channel_id);


--
-- Name: channel_overwrites channel_overwrites_pkey; Type: CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.channel_overwrites
    ADD CONSTRAINT channel_overwrites_pkey PRIMARY KEY (id);


--
-- Name: channels channels_pkey; Type: CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_pkey PRIMARY KEY (id);


--
-- Name: invites invites_pkey; Type: CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_pkey PRIMARY KEY (code);


--
-- Name: local_accounts local_accounts_handle_unique; Type: CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.local_accounts
    ADD CONSTRAINT local_accounts_handle_unique UNIQUE (handle);


--
-- Name: local_accounts local_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.local_accounts
    ADD CONSTRAINT local_accounts_pkey PRIMARY KEY (user_id);


--
-- Name: member_roles member_roles_user_id_role_id_pk; Type: CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.member_roles
    ADD CONSTRAINT member_roles_user_id_role_id_pk PRIMARY KEY (user_id, role_id);


--
-- Name: members members_pkey; Type: CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_pkey PRIMARY KEY (user_id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: messages messages_seq_unique; Type: CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_seq_unique UNIQUE (seq);


--
-- Name: mod_log mod_log_pkey; Type: CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.mod_log
    ADD CONSTRAINT mod_log_pkey PRIMARY KEY (id);


--
-- Name: radio_stations radio_stations_pkey; Type: CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.radio_stations
    ADD CONSTRAINT radio_stations_pkey PRIMARY KEY (id);


--
-- Name: read_states read_states_user_id_channel_id_pk; Type: CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.read_states
    ADD CONSTRAINT read_states_user_id_channel_id_pk PRIMARY KEY (user_id, channel_id);


--
-- Name: reports reports_pkey; Type: CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_pkey PRIMARY KEY (id);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: server_settings server_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.server_settings
    ADD CONSTRAINT server_settings_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_id_unique; Type: CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_id_unique UNIQUE (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (token);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_public_key_unique; Type: CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_public_key_unique UNIQUE (public_key);


--
-- Name: category_overwrites_category_idx; Type: INDEX; Schema: public; Owner: chat
--

CREATE INDEX category_overwrites_category_idx ON public.category_overwrites USING btree (category_id);


--
-- Name: category_overwrites_role_uq; Type: INDEX; Schema: public; Owner: chat
--

CREATE UNIQUE INDEX category_overwrites_role_uq ON public.category_overwrites USING btree (category_id, role_id);


--
-- Name: category_overwrites_user_uq; Type: INDEX; Schema: public; Owner: chat
--

CREATE UNIQUE INDEX category_overwrites_user_uq ON public.category_overwrites USING btree (category_id, user_id);


--
-- Name: channel_overwrites_channel_idx; Type: INDEX; Schema: public; Owner: chat
--

CREATE INDEX channel_overwrites_channel_idx ON public.channel_overwrites USING btree (channel_id);


--
-- Name: channel_overwrites_role_uq; Type: INDEX; Schema: public; Owner: chat
--

CREATE UNIQUE INDEX channel_overwrites_role_uq ON public.channel_overwrites USING btree (channel_id, role_id);


--
-- Name: channel_overwrites_user_uq; Type: INDEX; Schema: public; Owner: chat
--

CREATE UNIQUE INDEX channel_overwrites_user_uq ON public.channel_overwrites USING btree (channel_id, user_id);


--
-- Name: messages_channel_seq_idx; Type: INDEX; Schema: public; Owner: chat
--

CREATE INDEX messages_channel_seq_idx ON public.messages USING btree (channel_id, seq);


--
-- Name: mod_log_at_idx; Type: INDEX; Schema: public; Owner: chat
--

CREATE INDEX mod_log_at_idx ON public.mod_log USING btree (at);


--
-- Name: reports_message_idx; Type: INDEX; Schema: public; Owner: chat
--

CREATE INDEX reports_message_idx ON public.reports USING btree (message_id);


--
-- Name: reports_reported_idx; Type: INDEX; Schema: public; Owner: chat
--

CREATE INDEX reports_reported_idx ON public.reports USING btree (reported_user_id);


--
-- Name: reports_status_created_idx; Type: INDEX; Schema: public; Owner: chat
--

CREATE INDEX reports_status_created_idx ON public.reports USING btree (status, created_at);


--
-- Name: attachments attachments_message_id_messages_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_message_id_messages_id_fk FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE CASCADE;


--
-- Name: attachments attachments_uploader_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_uploader_id_users_id_fk FOREIGN KEY (uploader_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: bans bans_banned_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.bans
    ADD CONSTRAINT bans_banned_by_users_id_fk FOREIGN KEY (banned_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: bans bans_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.bans
    ADD CONSTRAINT bans_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: category_overwrites category_overwrites_category_id_categories_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.category_overwrites
    ADD CONSTRAINT category_overwrites_category_id_categories_id_fk FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE CASCADE;


--
-- Name: category_overwrites category_overwrites_role_id_roles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.category_overwrites
    ADD CONSTRAINT category_overwrites_role_id_roles_id_fk FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;


--
-- Name: category_overwrites category_overwrites_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.category_overwrites
    ADD CONSTRAINT category_overwrites_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: channel_blocks channel_blocks_blocked_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.channel_blocks
    ADD CONSTRAINT channel_blocks_blocked_by_users_id_fk FOREIGN KEY (blocked_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: channel_blocks channel_blocks_channel_id_channels_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.channel_blocks
    ADD CONSTRAINT channel_blocks_channel_id_channels_id_fk FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: channel_blocks channel_blocks_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.channel_blocks
    ADD CONSTRAINT channel_blocks_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: channel_mutes channel_mutes_channel_id_channels_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.channel_mutes
    ADD CONSTRAINT channel_mutes_channel_id_channels_id_fk FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: channel_mutes channel_mutes_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.channel_mutes
    ADD CONSTRAINT channel_mutes_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: channel_overwrites channel_overwrites_channel_id_channels_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.channel_overwrites
    ADD CONSTRAINT channel_overwrites_channel_id_channels_id_fk FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: channel_overwrites channel_overwrites_role_id_roles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.channel_overwrites
    ADD CONSTRAINT channel_overwrites_role_id_roles_id_fk FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;


--
-- Name: channel_overwrites channel_overwrites_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.channel_overwrites
    ADD CONSTRAINT channel_overwrites_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: channels channels_category_id_categories_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_category_id_categories_id_fk FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE SET NULL;


--
-- Name: channels channels_radio_started_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_radio_started_by_users_id_fk FOREIGN KEY (radio_started_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: channels channels_radio_station_id_radio_stations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_radio_station_id_radio_stations_id_fk FOREIGN KEY (radio_station_id) REFERENCES public.radio_stations(id) ON DELETE SET NULL;


--
-- Name: invites invites_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: local_accounts local_accounts_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.local_accounts
    ADD CONSTRAINT local_accounts_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: member_roles member_roles_role_id_roles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.member_roles
    ADD CONSTRAINT member_roles_role_id_roles_id_fk FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;


--
-- Name: member_roles member_roles_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.member_roles
    ADD CONSTRAINT member_roles_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: members members_confined_channel_id_channels_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_confined_channel_id_channels_id_fk FOREIGN KEY (confined_channel_id) REFERENCES public.channels(id) ON DELETE SET NULL;


--
-- Name: members members_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: messages messages_author_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_author_id_users_id_fk FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: messages messages_channel_id_channels_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_channel_id_channels_id_fk FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: mod_log mod_log_actor_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.mod_log
    ADD CONSTRAINT mod_log_actor_id_users_id_fk FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: mod_log mod_log_channel_id_channels_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.mod_log
    ADD CONSTRAINT mod_log_channel_id_channels_id_fk FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE SET NULL;


--
-- Name: mod_log mod_log_target_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.mod_log
    ADD CONSTRAINT mod_log_target_user_id_users_id_fk FOREIGN KEY (target_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: read_states read_states_channel_id_channels_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.read_states
    ADD CONSTRAINT read_states_channel_id_channels_id_fk FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: read_states read_states_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.read_states
    ADD CONSTRAINT read_states_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: reports reports_channel_id_channels_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_channel_id_channels_id_fk FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE SET NULL;


--
-- Name: reports reports_closed_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_closed_by_users_id_fk FOREIGN KEY (closed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: reports reports_reported_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_reported_user_id_users_id_fk FOREIGN KEY (reported_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: reports reports_reporter_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_reporter_id_users_id_fk FOREIGN KEY (reporter_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: server_settings server_settings_afk_channel_id_channels_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.server_settings
    ADD CONSTRAINT server_settings_afk_channel_id_channels_id_fk FOREIGN KEY (afk_channel_id) REFERENCES public.channels(id) ON DELETE SET NULL;


--
-- Name: server_settings server_settings_owner_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.server_settings
    ADD CONSTRAINT server_settings_owner_id_users_id_fk FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: server_settings server_settings_status_api_role_id_roles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.server_settings
    ADD CONSTRAINT server_settings_status_api_role_id_roles_id_fk FOREIGN KEY (status_api_role_id) REFERENCES public.roles(id) ON DELETE SET NULL;


--
-- Name: sessions sessions_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: chat
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict FEPxzt1MMDk36yL4tNrXZ39HALW1VwkH2rPDkI0eI6S5uiNA0J730coMxK6yh0w

