import stockSeed from "./stock-seed.json";

export type Product = {
  id: string;
  name: string;
  variant: string;
  sku: string;
  stock: number;
  price: number;
  shop: string;
  status: string;
  image?: string;
};
export type StockChange = {
  id: string;
  name: string;
  sku: string;
  delta: number;
  stock: number;
  time: string;
};
const photos: Record<string, string> = {
  "Bumbu Tabur": "tabur",
  Mayones: "mayonnaise",
  Mustard: "mustard",
  Kecap: "kecap",
  Beras: "beras",
  Bihun: "bihun",
  Chocolatos: "chocolatos",
  Bakso: "bakso",
};
export function productPhoto(name: string) {
  return Object.entries(photos).find(([key]) =>
    name.toLowerCase().includes(key.toLowerCase()),
  )?.[1];
}
export const stockProducts: Product[] = stockSeed.map((p, i) => ({
  ...p,
  price: 12500 + (i % 12) * 2500,
  shop: i % 3 === 0 ? "the jago snack & frozen food" : "A2HShop",
  status: p.stock === 0 ? "Stok Habis" : "Aktif",
  image: productPhoto(p.name),
}));
const names = [
  "Saus Mustard Maestro 255g - Rasa Khas Prancis, Praktis Digunakan, Tambahkan Kelezatan",
  "Kecap Manis Indofood Jerigen 5.7 kg - Rasa Gurih, Manis",
  "Kecap Asin Asia Harum Sedap 620 ml - Kecap Asin Gurih Serbaguna",
  "Mayones Sachet 9 Gram - Praktis, Higienis, Ekonomis",
  "Kecap Asin ABC 620ml - Hemat, Komposisi Berkualitas, Rasa Kaya",
  "Kecap Manis ABC 6 kg - Aroma Kedelai, Lezat, Cocok untuk Restoran",
  "Saus Tomat ABC 5.7 kg dengan Rasa Asam Manis Autentik",
  "Keju Meg Cheese Serbaguna",
  "Bakso Mawar Super Polos Cap Tiga Mawar Isi 15",
  "Bakso Grand Kirana Bom isi 5",
  "Bihun Beras Fitra Pilar Sejahtera",
  "Sotong Goreng & Tahu Bulat Jajanan Tasik",
  "Chili Oil / Minyak Cabai 9 gram",
  "Pop Ice All Varian Rasa Terlengkap 10 Sachet",
  "Bisohun Bihun Merah Renteng 60gr Isi 8 Pcs",
  "Alam Super Bi Baso Sapi Asli Isi 50 Urat Polos 300gr",
  "Chocolatos - Minuman Drink Rasa Coklat Lezatos",
  "Beras Cianjur Gentur Tengah 5Kg Super",
  "Bumbu Dasar Kaldu Indofood Ayam Kampung 250gr",
  "Bihun Jagung Doroku Cap Burung Dara",
];
export const demoProducts: Product[] = names.map((name, i) => ({
  id: `product-${i}`,
  name,
  variant: "Original",
  sku: `SKU-${String(i + 1).padStart(4, "0")}`,
  stock: [
    12, 2, 8, 990, 12, 2, 2, 50, 100, 100, 100077, 200, 100, 1800, 100, 100, 48,
    35, 16, 12,
  ][i]!,
  price: [34000, 157500, 37500, 12500, 29000, 190000, 140000][i % 7]!,
  shop: i < 10 ? "A2HShop" : "the jago snack & frozen food",
  status: i === 14 ? "Draft" : i === 15 ? "Diarsipkan" : "Aktif",
  image: productPhoto(name),
}));
export const demoHistory: StockChange[] = [
  "Jamur Es Salju Kuping Putih 1Pak 500gr - Jamur Kering HALAL untuk Sayur Sop, Topping Seblak",
  "Saus Hot Lava 1 Kg Saus Sambal Pedas Delisaos HOTLAVA",
  "Diamond Susu UHT Full Cream 1L Susu Cair Murni",
  "Kwetiau Basah Super Kenyal - Pilihan Terbaik untuk Masakan Anda",
  "Saus Hot Lava 1 Kg Saus Sambal Pedas",
  "Minyak Samin Cap Onta 200gr Paket Termurah",
].map((name, i) => ({
  id: `history-${i}`,
  name,
  sku: `SKU-${i + 100}`,
  delta: i === 3 ? -10 : -1,
  stock: [0, 3, 23, 468, 4, 58][i]!,
  time: `2026-09-24T${String(23 - i).padStart(2, "0")}:14:00`,
}));
