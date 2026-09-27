import unittest

from garment_dynamics import garment_kind, garment_spring_settings


class GarmentDynamicsTests(unittest.TestCase):
    def test_recognizes_material_independent_cloth_bones(self):
        self.assertEqual(garment_kind("SKIRT_0_4"), "skirt")
        self.assertEqual(garment_kind("左袖2"), "sleeve")
        self.assertEqual(garment_kind("Cape_03"), "cape")
        self.assertIsNone(garment_kind("左ひじ"))
        self.assertIsNone(garment_kind("左足"))

    def test_distal_cloth_is_softer_without_unbounded_gravity(self):
        root = garment_spring_settings("skirt", 0, 7)
        tip = garment_spring_settings("skirt", 6, 7)
        self.assertGreater(root["stiffness"], tip["stiffness"])
        self.assertLess(root["gravity_power"], tip["gravity_power"])
        self.assertLess(tip["gravity_power"], 0.1)


if __name__ == "__main__":
    unittest.main()
