import gzip
import math
from pathlib import Path
import struct

import pytest

from gateway.robot.mapcheck import OccupancyGrid, is_cell_free, parse_map_blob


def make_blob(width=20, height=20, res=0.1, ox=-1.0, oy=-1.0, yaw=0.0):
    # Independent encoding copied from nav_web.py:1526-1538, not parser constants.
    cells = bytearray(width * height)
    for row in range(height):
        cells[row * width + 10] = 100
    cells[:width] = bytes([255]) * width
    return gzip.compress(struct.pack("<7f", 7.0, width, height, res, ox, oy, yaw) + cells, mtime=0)


def test_source_layout_round_trip_and_generated_fixture():
    blob = make_blob()
    path = Path(__file__).parent / "fixtures" / "map_small.bin"
    path.parent.mkdir(exist_ok=True)
    path.write_bytes(blob)
    grid = parse_map_blob(path.read_bytes())
    assert (grid.width, grid.height) == (20, 20)
    assert grid.resolution == pytest.approx(0.1)
    assert (grid.origin_x, grid.origin_y, grid.origin_yaw) == (-1.0, -1.0, 0.0)
    assert len(grid.data) == 400
    assert grid.data[:20] == bytes([255]) * 20
    assert grid.data[210] == 100


def test_free_wall_and_radius():
    grid = parse_map_blob(make_blob())
    assert is_cell_free(grid, -0.5, -0.5, 0) == (True, "ok")
    assert is_cell_free(grid, 0.05, -0.5, 0) == (False, "occupied")
    assert is_cell_free(grid, -0.15, -0.5, 0) == (True, "ok")
    assert is_cell_free(grid, -0.15, -0.5) == (False, "occupied")


def test_unknown_and_map_edge_anywhere_in_footprint_are_unsafe():
    grid = parse_map_blob(make_blob())
    assert is_cell_free(grid, 50, 50, 0) == (False, "outside_map")
    assert is_cell_free(grid, -1.001, -0.5, 0) == (False, "outside_map")
    assert is_cell_free(grid, -0.5, -0.95, 0) == (False, "unknown")
    assert is_cell_free(grid, -0.5, -0.75, 0.2) == (False, "unknown")
    assert is_cell_free(grid, -0.9, 0, 0.2) == (False, "outside_map")


def test_rotated_origin_transforms_world_coordinates():
    grid = parse_map_blob(make_blob(ox=3, oy=4, yaw=math.pi / 2))
    assert grid.origin_yaw == pytest.approx(math.pi / 2)
    # Local (0.55, 0.55) -> world (2.45, 4.55); local wall x=1.05.
    assert is_cell_free(grid, 2.45, 4.55, 0) == (True, "ok")
    assert is_cell_free(grid, 2.45, 5.05, 0) == (False, "occupied")
    assert is_cell_free(grid, 3.05, 4.55, 0) == (False, "outside_map")


def test_exact_circle_intersects_cell_square_not_only_cell_centers():
    cells = bytearray(25)
    cells[2 * 5 + 3] = 100
    grid = OccupancyGrid(1, 0, 0, 5, 5, bytes(cells))
    assert is_cell_free(grid, 2.95, 2.5, 0.1) == (False, "occupied")
    assert is_cell_free(grid, 2.1, 2.5, 0.1) == (True, "ok")
    # Diagonal square outside the actual circle should not cause refusal.
    assert is_cell_free(grid, 2.5, 1.5, 0.6) == (True, "ok")


def test_footprint_tangent_to_left_cell_is_not_missed():
    cells = bytearray(25)
    cells[2 * 5 + 1] = 100
    grid = OccupancyGrid(1, 0, 0, 5, 5, bytes(cells))
    assert is_cell_free(grid, 2.5, 2.5, 0.5) == (False, "occupied")


@pytest.mark.parametrize("value,want", [(0, (True, "ok")), (64, (True, "ok")), (65, (False, "occupied")), (100, (False, "occupied")), (255, (False, "unknown"))])
def test_source_occupancy_threshold(value, want):
    grid = OccupancyGrid(1, 0, 0, 1, 1, bytes([value]))
    assert is_cell_free(grid, 0.5, 0.5, 0) == want


@pytest.mark.parametrize("field,value", [(0, math.nan), (0, -1), (1, 0), (1, 1.5), (2, -2), (3, 0), (3, -0.1), (3, math.inf), (4, math.nan), (5, math.inf), (6, math.nan)])
def test_malformed_header_is_rejected(field, value):
    header = [1, 1, 1, 0.1, 0, 0, 0]
    header[field] = value
    with pytest.raises(ValueError):
        parse_map_blob(gzip.compress(struct.pack("<7f", *header) + b"\x00"))


@pytest.mark.parametrize("blob", [b"not gzip", gzip.compress(b"short"), gzip.compress(struct.pack("<7f", 1, 1, 1, 0.1, 0, 0, 0)), gzip.compress(struct.pack("<7f", 1, 1, 1, 0.1, 0, 0, 0) + b"\x00\x00"), gzip.compress(struct.pack("<7f", 1, 1, 1, 0.1, 0, 0, 0) + b"\xfe")])
def test_malformed_payload_is_rejected(blob):
    with pytest.raises(ValueError):
        parse_map_blob(blob)


@pytest.mark.parametrize("x,y,radius", [(math.nan, 0, 0), (0, math.inf, 0), (0, 0, -1), (0, 0, math.inf)])
def test_invalid_goal_cannot_pass(x, y, radius):
    with pytest.raises(ValueError):
        is_cell_free(parse_map_blob(make_blob()), x, y, radius)


def test_direct_grid_must_also_be_valid():
    with pytest.raises(ValueError):
        OccupancyGrid(0, 0, 0, 1, 1, b"\x00")
    with pytest.raises(ValueError):
        OccupancyGrid(1, 0, 0, 1, 1, b"")
