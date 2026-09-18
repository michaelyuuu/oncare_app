"""Fail-closed occupancy-grid checks before sending an approved goal.

Source: on_software_all/robot/mobile/web/nav_web.py:1526-1538, map_blob.
Wire format is gzip(<7 little-endian float32> + width*height uint8 cells).
Header order: map version, width, height, resolution (metres/cell),
origin_x, origin_y, origin_yaw (radians). Cells are ROS occupancy values
masked with 0xff: 0 free, 100 occupied, -1 becomes 255 unknown; intermediate
0..100 probabilities are valid. nav_web.py:227/1122-1142 uses threshold65.

Unlike the source's point check, the gateway checks the entire circular
footprint: any intersecting unknown/occupied cell or outside-map area fails.
Origin rotation is inverted before checking cell coordinates. This is a
static goal-footprint check, not a substitute for navigation collision checks.
Fixtures are synthetic; live map compatibility still needs attended testing.
"""

from dataclasses import dataclass
import gzip
import math
import struct
import zlib


HEADER = struct.Struct("<7f")
OCC_THRESHOLD = 65


@dataclass(frozen=True)
class OccupancyGrid:
    resolution: float
    origin_x: float
    origin_y: float
    width: int
    height: int
    data: bytes
    origin_yaw: float = 0.0

    def __post_init__(self):
        if not all(math.isfinite(v) for v in (
            self.resolution, self.origin_x, self.origin_y, self.origin_yaw
        )) or self.resolution <= 0:
            raise ValueError("invalid map geometry")
        if (type(self.width) is not int or type(self.height) is not int
                or self.width <= 0 or self.height <= 0):
            raise ValueError("invalid map dimensions")
        if not isinstance(self.data, bytes) or len(self.data) != self.width * self.height:
            raise ValueError("map cell count mismatch")
        if any(value > 100 and value != 255 for value in self.data):
            raise ValueError("invalid occupancy value")


def parse_map_blob(blob: bytes) -> OccupancyGrid:
    try:
        raw = gzip.decompress(blob)
    except (OSError, EOFError, zlib.error) as exc:
        raise ValueError("invalid gzip map") from exc
    if len(raw) < HEADER.size:
        raise ValueError("map header truncated")
    version, width, height, resolution, ox, oy, yaw = HEADER.unpack_from(raw)
    if not all(math.isfinite(v) for v in (version, width, height, resolution, ox, oy, yaw)):
        raise ValueError("non-finite map header")
    if version < 0 or not version.is_integer():
        raise ValueError("invalid map version")
    if width <= 0 or height <= 0 or not width.is_integer() or not height.is_integer():
        raise ValueError("invalid map dimensions")
    return OccupancyGrid(resolution, ox, oy, int(width), int(height), raw[HEADER.size:], yaw)


def is_cell_free(grid: OccupancyGrid, x: float, y: float,
                 radius_m: float = 0.35) -> tuple[bool, str]:
    if not all(math.isfinite(v) for v in (x, y, radius_m)) or radius_m < 0:
        raise ValueError("goal coordinates and nonnegative radius must be finite")
    dx, dy = x - grid.origin_x, y - grid.origin_y
    cosine, sine = math.cos(grid.origin_yaw), math.sin(grid.origin_yaw)
    # Rotate world displacement by -origin_yaw into grid-local metres.
    lx, ly = cosine * dx + sine * dy, -sine * dx + cosine * dy
    max_x, max_y = grid.width * grid.resolution, grid.height * grid.resolution
    if (lx - radius_m < 0 or ly - radius_m < 0
            or lx + radius_m >= max_x or ly + radius_m >= max_y):
        return False, "outside_map"
    left = math.floor((lx - radius_m) / grid.resolution)
    right = math.floor((lx + radius_m) / grid.resolution)
    bottom = math.floor((ly - radius_m) / grid.resolution)
    top = math.floor((ly + radius_m) / grid.resolution)
    if radius_m > 0:
        # Include left/bottom cells that may touch an exactly aligned boundary;
        # the square-distance test removes nonintersecting extra candidates.
        left = max(0, left - 1)
        bottom = max(0, bottom - 1)
    unknown = False
    for row in range(bottom, top + 1):
        for col in range(left, right + 1):
            # Minimum distance from the actual goal to the cell's square.
            near_x = max(col * grid.resolution - lx, 0,
                         lx - (col + 1) * grid.resolution)
            near_y = max(row * grid.resolution - ly, 0,
                         ly - (row + 1) * grid.resolution)
            if near_x * near_x + near_y * near_y > radius_m * radius_m:
                continue
            value = grid.data[row * grid.width + col]
            if value == 255:
                unknown = True
            elif value >= OCC_THRESHOLD:
                return False, "occupied"
    return (False, "unknown") if unknown else (True, "ok")
