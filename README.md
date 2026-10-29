# Card Shelf (SillyTavern Extension)

หน้าต่างเดียว สองแท็บ: **Datacat** กับ **JanitorAI**

ดูบอทบน JanitorAI (Ranking, Trending) แล้วคัดลอกลิงก์บอท ไปแท็บ Datacat วางลิงก์ Datacat จะสร้างการ์ดและนำเข้าให้ first mes ครบ ลอร์บุ๊คมาด้วย เพราะเป็นระบบนำเข้าของ Datacat เอง Card Shelf ไม่ได้แปลงอะไรเอง

และมีตัวเลือก **หยุด/ซ่อนแมวเต้นของ Datacat** บนแถบด้านบน สำหรับคนที่จอกระตุก

## ต้องมี

- [Datacat SillyTavern Browser](https://github.com/datacat-run/datacat-sillytavern-browser) — แท็บ Datacat คือหน้าต่างของ Datacat ตัวนี้ ถ้ายังไม่ได้ติดตั้ง แท็บ Datacat จะบอกวิธีติดตั้ง

## ติดตั้ง

ใน SillyTavern เปิด **Extensions → Install extension** แล้ววาง URL นี้:

```
https://github.com/inathael-58/SillyTavern-Card-Shelf
```

## ใช้

1. เปิด Card Shelf จากไอคอนเข็มทิศ 🧭 บนแถบด้านบน เมนูไม้กายสิทธิ์ (Extensions) หรือคำสั่ง `/shelf`
2. แท็บ **JanitorAI** กด **Ranking** / **Trending** / **หน้าแรก** ด้านบนได้
3. เจอบอทที่ชอบ กดค้าง (มือถือ) หรือคลิกขวา (คอม) ที่บอท → **คัดลอกลิงก์**
4. ไปแท็บ **Datacat** วางลิงก์ แล้วนำเข้าตามปกติของ Datacat
5. นำเข้าเสร็จ Datacat เปิดแชทใหม่ให้ Card Shelf ปิดเองให้เห็นแชทเลย (ปิดตัวเลือกนี้ได้ในการตั้งค่า)

สลับแท็บไปมาได้ หน้า JanitorAI กับ Datacat ไม่โหลดใหม่ ปิด Card Shelf แล้วเปิดใหม่ก็ยังอยู่หน้าเดิม

คำสั่ง: `/shelf` · `/shelf datacat` · `/shelf janitor` · `/shelf ranking` · `/shelf trending` (`/janitor` ก็ได้)

### ถ้าแท็บ JanitorAI ว่าง หรือล็อกอินไม่ได้

บางเบราว์เซอร์ไม่ให้เว็บอื่นแสดง JanitorAI ข้างใน หรือไม่ให้ล็อกอินในกรอบ (cookie ของเว็บอื่น) กดปุ่ม ↗ ที่แถบด้านบนของแท็บ เพื่อเปิด JanitorAI ในหน้าต่างใหม่ คัดลอกลิงก์บอทจากตรงนั้น แล้วกลับมาวางในแท็บ Datacat ได้เหมือนกัน

ถ้า JanitorAI ย้ายหน้า Ranking หรือ Trending ไป แก้ลิงก์ของปุ่มได้ใน **Extensions → Card Shelf → ปุ่มในแท็บ JanitorAI**

## แมว Datacat

ใน **Extensions → Card Shelf → แมว Datacat บนแถบด้านบน**:

| ตัวเลือก | |
|---|---|
| เต้นตามปกติ | ไม่ยุ่งกับ Datacat |
| หยุดนิ่ง | เปลี่ยน GIF เป็นรูปนิ่งเฟรมแรก กดเปิด Datacat ได้เหมือนเดิม |
| ซ่อน | ซ่อนปุ่มบนแถบด้านบน เปิด Datacat จาก Card Shelf หรือเมนูไม้กายสิทธิ์ → Explore |

GIF ที่เล่นตลอดทำให้เบราว์เซอร์วาดแถบด้านบนใหม่ทุกเฟรม บางเครื่องรู้สึกกระตุกตอนบอทกำลังพิมพ์ Card Shelf ไม่ลบปุ่มของ Datacat (Datacat จะสร้างใหม่ถ้าหายไป) แค่หยุดภาพหรือซ่อนด้วย CSS

## ทำงานยังไง

แท็บ Datacat คือหน้าต่างของ Datacat SillyTavern Browser เอง (iframe เดิมของมัน พร้อมระบบนำเข้าของมัน) Card Shelf แค่ขอให้ Datacat เปิดหน้าต่าง แล้วย้ายหน้าต่างนั้นมาวางในแท็บ Card Shelf ไม่ได้คุยกับ datacat.run เอง ไม่ได้อ่านหรือส่งข้อมูลการ์ด

แท็บ JanitorAI เป็นเว็บ janitorai.com ในกรอบ ไม่ต้องเปิดพร็อกซีใน `config.yaml`

## พัฒนา

```bash
npm test
```

## License

GNU Affero General Public License v3.0 ดู [LICENSE](LICENSE)
