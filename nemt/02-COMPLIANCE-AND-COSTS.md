# Stage 2 — Registration Stack, In Dependency Order

**Do not start this until Stage 0 returned a GO and Stage 1 funded the gate.**

There is no single "NEMT license." It's a stack of federal registrations, state permits,
local authorizations, and program enrollments — each with its own fee, its own form, and
its own timeline. Done in the wrong order you pay for things you don't end up needing.

Total first-year licensing runs **$484–$14,850** depending on state, with most standard
states landing at **$1,000–$5,000** for a single-vehicle startup. The spread is driven
almost entirely by whether your state has **Certificate of Need (CON)** laws for medical
transport — check that first, because in a CON state this plan may not be viable at all as
a new entrant.

---

## Order of operations

### Step 0 — Two free checks, before anything else

| Check | How | Why it comes first |
|---|---|---|
| **Does your state have CON for NEMT?** | Search "[state] certificate of need non-emergency medical transportation" | In a CON state you may need to prove unmet need or be blocked entirely by incumbents. This can be a hard stop. |
| **Insurance quote** | Script 3 in `01-VALIDATION-SCRIPTS.md` | It's the largest recurring cost and the most common plan-killer. Know it before spending on registration. |

Both are free. Both can end the project. Do them first.

### Step 1 — Entity and identifiers

| Item | Cost | Time | Notes |
|---|---|---|---|
| LLC registration | $50–$500 | 1–14 days | File directly with your Secretary of State. Do **not** pay a formation service $300 to fill in a form you can file yourself in 20 minutes. |
| EIN | **$0** | Same day | Directly from IRS.gov. Anyone charging for an EIN is scamming you. |
| NPI number | **$0** | 1–10 days | Via NPPES. Required to bill Medicaid. Free, always. |
| Business bank account | $0–$25/mo | 1 day | Open before any money moves. Never run this through a personal account. |

### Step 2 — Insurance (bind only when ready to operate)

| Policy | Annual cost | Required? |
|---|---|---|
| Commercial auto, $1M liability (sedan/minivan) | $5,500–$9,000 | **Yes** — brokers require $1M; SafeRide has accepted $500k |
| Commercial auto, wheelchair-accessible van | $7,500–$13,500 | If/when you add WAV capacity |
| General liability | $2,500–$3,500 | Usually required by facility contracts |
| Excess/umbrella liability | $3,500–$4,500 | Only if a contract requires it |
| Workers comp | ~$2,000 | Only once you have employees |

**Down payment at binding: 20–35% of the annual premium.** Budget $1,600–$3,150 for an
ambulatory start. First-year operators pay 30–50% above established-operator rates because
you have no loss history — a $6,000 premium for an established operator is $8,000–$9,000
for you. This is not negotiable and does not indicate you're being ripped off.

Time your binding date carefully: the policy starts costing money immediately, so bind
when your first contracts are ready to run, not months ahead.

### Step 3 — Operating authority

| Item | Cost | Notes |
|---|---|---|
| USDOT number | $300 | Required in most states for passenger transport |
| State NEMT operating license/certificate | $0–$1,500 | Varies enormously; this is where CON states get expensive |
| City/county business license | $50–$400 | Easy to forget; brokers check it |
| Vehicle inspection | $50–$200 | State or broker-mandated, often annual |

### Step 4 — Driver and vehicle credentialing

Required by brokers before portal activation. Start these **early** — they have lead times
and they expire.

- Background check via **Checkr** (broker-run)
- **OIG LEIE** clearance (excluded-provider list)
- **NSOPW** clearance (sex offender registry)
- Current **CPR and First Aid** certification — start this in Stage 1; it's cheap, takes a
  day, and expires
- **PASS** (Passenger Assistance Safety and Sensitivity) or equivalent training
- Clean **MVR**
- Age 21+, most brokers require 25+
- Valid Chauffeur / Class D or CDL

**Renewal trap:** ModivCare deactivates any driver whose background screening is more than
365 days old. Calendar every expiration the day you receive it.

### Step 5 — Vehicle equipment

Broker-specified and inspected. Roughly $200–$400 total:

- Fully stocked first aid kit (ModivCare specifies 13 required items — get their list, not
  a generic kit)
- Class A-B-C fire extinguisher, secured within driver's reach
- Bloodborne pathogen spill kit
- Seat belt cutter
- GPS or current maps
- Two-way communication device

**Vehicle eligibility:** under 8 years old at broker enrollment, hard exit at 10 years,
200,000+ miles draws additional scrutiny. Check your vehicle's year *before* planning
around it — an ineligible vehicle changes your capital gate by tens of thousands of dollars.

### Step 6 — Enrollment

1. **Broker enrollment** — ModivCare, MTM, Veyo, SafeRide Health, Access2Care. Faster and
   simpler than direct Medicaid billing; the broker handles eligibility verification and
   billing and pays you directly. Most new providers start here.
2. **Direct Medicaid provider enrollment** — more paperwork, better rates, worth doing once
   you have volume.
3. **Private facility contracts** — from your Stage 0 callback list. These are the
   high-margin work and require no enrollment at all, just a signed agreement and proof of
   insurance.

---

## Running cost floor, once operating

This is what leaves your account every month whether you run 10 trips or 200:

| Fixed monthly | Amount |
|---|---|
| Insurance (financed monthly) | $460–$750 |
| Scheduling/dispatch software | $50–$200 |
| Vehicle payment (if financed) | $0–$700 |
| Phone, accounting, misc | $75–$150 |
| **Monthly nut** | **$585–$1,800** |

Add fuel and maintenance, which scale with trips (roughly $0.20–$0.35/mile all-in for a
sedan or minivan).

**The implication people miss:** because insurance is fixed, low volume doesn't merely earn
less — it loses money. At the bottom of that range you need roughly **20–30 ambulatory
trips a month just to break even.** Model your own numbers in the calculator before you
bind a policy.

---

## What to skip

- **"NEMT startup packages" and courses** — $500–$5,000 for information that's free from
  your state Medicaid office and the brokers' own enrollment pages
- **LLC formation services** — you can file with your Secretary of State yourself
- **Anyone charging for an EIN or NPI** — both are free from the government
- **Buying a wheelchair van before you have WAV contracts** — $43k–$71k for capacity you
  can't yet fill, plus $7,500–$13,500/year insurance instead of $5,500–$9,000
- **Custom branding, wraps, websites, business cards** before the first contract — facilities
  hire you because a social worker trusts you, not because of a logo

---

## Realistic timeline from GO

| Phase | Duration |
|---|---|
| Entity + free identifiers | 1–2 weeks |
| Insurance quotes → binding | 2–4 weeks |
| State license + USDOT | 2–8 weeks (CON states: longer) |
| Broker credentialing | 4–12 weeks |
| **Total to first legal trip** | **2–5 months** |

Which is why Stage 1 — driving for someone else while the gate money accumulates — isn't a
detour. It runs concurrently with all of this, and it's the only reason the timeline is
affordable.
