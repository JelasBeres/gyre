# GYRE mark: three currents spiral out of a calm eye and run into the ring that holds them (an ocean gyre seen from above).
# python3 make-mark.py -> gyre-mark.svg (cyan), gyre-mark-mono.svg (currentColor), favicon.svg (on abyss tile)
import math
C = 50
def spiral(r0, r1, turns, a0, n=160):
    b = math.log(r1 / r0) / (turns * 2 * math.pi); pts = []
    for i in range(n + 1):
        t = i / n * turns * 2 * math.pi; r = r0 * math.exp(b * t); a = a0 + t
        pts.append((C + r * math.cos(a), C + r * math.sin(a)))
    return pts
def path(pts): return "M" + " L".join(f"{x:.2f},{y:.2f}" for x, y in pts)
R = 40.0
# three currents leave the eye a third of a turn apart and sweep out until they run along the ring
arms = [spiral(8.5, R, 0.40, math.radians(-90 + k * 120)) for k in range(3)]
d = " ".join(path(a) for a in arms)
def svg(stroke, bg=None, w=7.5):
    tile = f'<rect width="100" height="100" rx="24" fill="{bg}"/>' if bg else ""
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>GYRE</title>{tile}<path d="{d}" fill="none" stroke="{stroke}" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round"/><circle cx="{C}" cy="{C}" r="{R}" fill="none" stroke="{stroke}" stroke-width="{w}"/></svg>'
open("gyre-mark.svg", "w").write(svg("#3FE0D0"))
open("gyre-mark-mono.svg", "w").write(svg("currentColor"))
open("favicon.svg", "w").write(svg("#3FE0D0", "#04121C", 8.5))
