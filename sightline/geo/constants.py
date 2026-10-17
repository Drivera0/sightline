"""Team-agreed geospatial constants.

``SECTOR_NW`` remains unset until the survey sector is selected. Importers must
not silently substitute a value: Lane B and Lane C need to agree on it first.
"""

from sightline.contract import LatLon

LKP = LatLon(lat=49.370000, lon=-122.945000)
SECTOR_NW: LatLon | None = None

