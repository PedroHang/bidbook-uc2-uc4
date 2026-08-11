"""
gen_catalogue.py — writes sample_catalogue.json, the fabricated price book.

Run once, output committed and hand-reviewed. ~150 lines shaped like a
fit-out specialty/GC contractor's catalogue: {code, csi_section, description,
uom}. NO PRICES anywhere — nothing in this demo prices anything.

Two gaps are deliberate and load-bearing for the demo narrative:
  - section 10 44 00 (fire extinguishers) has no lines
  - division 27 (communications) has no lines at all
so the "catalogue gap" state occurs naturally on Ray's own sample document.
Every UI surface that shows this data is tagged SAMPLE.
"""

import json
from pathlib import Path

ITEMS = []


def add(section: str, seq: int, description: str, uom: str) -> None:
    code = f"{section.replace(' ', '')}-{seq:03d}"
    ITEMS.append({"code": code, "csi_section": section, "description": description, "uom": uom})


# Division 01 — deliberately thin: general requirements are rarely priced from a catalogue
add("01 50 00", 110, "Temporary facilities and controls, monthly", "MO")
add("01 74 19", 120, "Construction waste disposal, 30 CY container", "EA")

# Division 02
add("02 41 19", 110, "Selective demolition, interior non-structural", "SF")
add("02 41 19", 140, "Sawcut and remove existing slab section", "SF")

# Division 03 — concrete
add("03 30 00", 110, "Cast-in-place concrete, 3000 PSI, formed", "CY")
add("03 31 00", 140, "Cast-in-place footing, 3000 PSI", "CY")
add("03 30 53", 220, "Slab infill at openings, 4 in, doweled to existing", "SF")
add("03 15 19", 110, "Anchor bolt set, cast-in, per template", "EA")
add("03 35 19", 100, "Slab grind and prep to receive finish flooring", "SF")
add("03 35 43", 60, "Penetrating concrete sealer, water based", "SF")
add("03 01 30", 210, "Crack and spall patching, epoxy mortar", "LF")

# Division 05
add("05 50 00", 120, "Miscellaneous metal fabrications, galvanized", "LB")
add("05 51 00", 140, "Steel stair, shop fabricated, per flight", "EA")

# Division 06 — millwork / casework
add("06 41 16", 120, "Plastic-laminate base cabinet, 36 in", "LF")
add("06 41 16", 160, "Plastic-laminate upper cabinet, 30 in", "LF")
add("06 61 16", 140, "Solid surface countertop, 25 in deep", "LF")
add("06 22 13", 80, "Wood trim and standing rail, painted grade", "LF")
add("06 10 00", 100, "Rough carpentry and in-wall blocking", "SF")

# Division 07 — thermal & moisture
add("07 21 16", 130, "Batt insulation, R-13, 3-1/2 in, in stud wall", "SF")
add("07 21 16", 210, "Acoustic batt at interior partitions", "SF")
add("07 26 00", 40, "Vapor retarder, 6 mil polyethylene", "SF")
add("07 84 13", 110, "Penetration firestopping, through-wall", "EA")
add("07 92 13", 110, "Joint sealant, silicone, exterior grade", "LF")
add("07 92 13", 60, "Joint sealant, acrylic latex, interior", "LF")
add("07 91 26", 20, "Backer rod, closed cell", "LF")
add("07 53 23", 130, "EPDM membrane patch at roof penetration", "SF")

# Division 08 — openings
add("08 11 13", 140, "Hollow metal frame, 16 ga, welded, painted", "EA")
add("08 11 13", 210, "Flush hollow metal door, 18 ga, 3'-0\" x 7'-0\"", "EA")
add("08 14 16", 120, "Solid core wood door, plain sliced, prefinished", "EA")
add("08 43 13", 100, "Aluminum storefront system, 1 in insulated glazing", "SF")
add("08 43 13", 320, "Storefront entry door, narrow stile, 3'-0\"", "EA")
add("08 71 00", 140, "Door hardware set, mortise lock, lever", "EA")
add("08 71 20", 90, "Building-standard cylinder, keyed", "EA")
add("08 80 00", 110, "Interior glazing, 1/4 in tempered", "SF")

# Division 09 — finishes (the fattest division, as in a real fit-out book)
add("09 21 16", 330, "GWB partition, 3-5/8 in metal stud, one layer each side", "SF")
add("09 21 16", 410, "Shaft wall assembly, 2-hour", "SF")
add("09 29 00", 120, "Gypsum board finish, Level 4, tape and sand", "SF")
add("09 29 00", 160, "Gypsum board finish, Level 5, skim coat", "SF")
add("09 22 16", 110, "Non-structural metal framing, ceilings and soffits", "SF")
add("09 51 23", 110, "Acoustical panel ceiling, 2x2 tile and grid", "SF")
add("09 51 23", 260, "Ceiling perimeter trim, shadow molding", "LF")
add("09 22 26", 130, "Suspension system, heavy duty, seismic", "SF")
add("09 65 13", 100, "Resilient wall base, 4 in coved", "LF")
add("09 65 13", 140, "Resilient wall base, 6 in straight", "LF")
add("09 65 13", 900, "Base and flooring adhesive", "GAL")
add("09 65 19", 120, "Luxury vinyl tile, glue down", "SF")
add("09 30 13", 140, "Ceramic tile, floor, thinset", "SF")
add("09 30 13", 240, "Ceramic tile, wall, thinset", "SF")
add("09 91 23", 110, "Paint, interior wall, latex, 2 coats", "SF")
add("09 91 23", 260, "Paint, hollow metal door and frame, alkyd", "EA")
add("09 91 23", 310, "Paint, exposed structure and deck, dryfall", "SF")
add("09 91 13", 40, "Primer, block filler, masonry", "SF")
add("09 96 00", 120, "High-performance coating, epoxy, 2 coat", "SF")

# Division 10 — specialties. 10 44 00 (fire protection specialties) DELIBERATELY ABSENT.
add("10 14 00", 110, "Interior signage, room identification, ADA", "EA")
add("10 21 13", 120, "Toilet compartment, solid plastic, floor mounted", "EA")
add("10 28 00", 130, "Toilet accessories, commercial set", "EA")

# Division 12
add("12 36 61", 140, "Solid surface vanity top", "LF")
add("12 48 13", 110, "Entrance floor mat and frame, recessed", "SF")

# Division 21 — fire suppression
add("21 13 13", 140, "Wet pipe sprinkler main, 4 in, schedule 10", "LF")
add("21 13 13", 320, "Sprinkler drop and head, semi-recessed, chrome", "EA")
add("21 13 13", 360, "Sprinkler head relocation", "EA")
add("21 12 00", 110, "Fire department connection, exposed", "EA")

# Division 22 — plumbing
add("22 11 16", 120, "Domestic water pipe, copper, 1 in, insulated", "LF")
add("22 05 23", 60, "Gate valve, bronze, 1 in", "EA")
add("22 07 19", 40, "Pipe insulation, fiberglass, 1 in", "LF")
add("22 13 16", 130, "Sanitary waste pipe, PVC, 4 in, buried", "LF")
add("22 42 13", 110, "Water closet, floor mounted, commercial", "EA")
add("22 42 16", 120, "Lavatory, wall hung, with faucet", "EA")
add("22 47 13", 110, "Electric water cooler, bi-level, ADA", "EA")
add("22 33 30", 120, "Electric water heater, point of use, 20 gal", "EA")

# Division 23 — HVAC
add("23 74 13", 150, "Packaged rooftop unit, 5 ton, gas/electric", "EA")
add("23 74 13", 180, "Packaged rooftop unit, 10 ton, gas/electric", "EA")
add("23 31 13", 220, "Ductwork, galvanized, medium pressure", "LB")
add("23 37 13", 110, "Diffuser, supply, 2x2 lay-in", "EA")
add("23 37 13", 140, "Grille, return, 2x2 lay-in", "EA")
add("23 05 93", 10, "Testing, adjusting and balancing", "LS")
add("23 09 00", 130, "DDC controls, per zone", "EA")
add("23 23 00", 120, "Refrigerant piping, line set, per ton", "EA")

# Division 26 — electrical
add("26 24 16", 340, "Panelboard, 400 A, 277/480 V, 3 phase, 42 circuit", "EA")
add("26 24 16", 220, "Panelboard, 225 A, 120/208 V, 3 phase", "EA")
add("26 05 19", 420, "Feeder, conduit and wire, 400 A, aluminum", "LF")
add("26 22 13", 110, "Dry-type transformer, 75 kVA", "EA")
add("26 05 33", 120, "Branch conduit, EMT, 3/4 in, with wire", "LF")
add("26 27 26", 110, "Duplex receptacle, spec grade, in wall", "EA")
add("26 27 26", 140, "GFCI receptacle, 20 A", "EA")
add("26 51 13", 210, "LED downlight, 6 in, dimmable", "EA")
add("26 51 13", 380, "Track lighting, 4 ft section, 2 heads", "LF")
add("26 51 13", 420, "LED linear pendant, 4 ft", "EA")
add("26 09 23", 120, "Dimming control station, 0-10V", "EA")
add("26 52 13", 110, "Exit sign, LED, battery backup", "EA")
add("26 56 19", 130, "Exterior wall pack, LED, photocell", "EA")

# Division 27 — DELIBERATELY ABSENT (communications): the second natural catalogue gap.

# Division 28
add("28 31 00", 120, "Smoke detector, addressable, ceiling", "EA")
add("28 31 00", 160, "Horn/strobe, wall mounted, ADA", "EA")

# Division 32
add("32 13 13", 120, "Concrete sidewalk, 4 in, broom finish", "SF")
add("32 17 23", 110, "Pavement marking, parking stall", "EA")


def main() -> None:
    out = Path(__file__).with_name("sample_catalogue.json")
    payload = {
        "_note": ("FABRICATED SAMPLE catalogue for the Scope IQ demo. No prices, on purpose. "
                  "Sections 10 44 00 and all of division 27 are deliberately absent so the "
                  "catalogue-gap state occurs naturally."),
        "items": ITEMS,
    }
    out.write_text(json.dumps(payload, indent=1), encoding="utf-8")
    print(f"wrote {len(ITEMS)} items to {out}")


if __name__ == "__main__":
    main()
