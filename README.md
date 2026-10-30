# Card Shelf (SillyTavern Extension)

หน้าต่างเดียว สองแท็บ: **Datacat** กับ **JanitorAI**

แท็บ JanitorAI แสดงรายชื่อบอท **Ranking / Trending / ล่าสุด** ค้นหาได้ แตะบอทแล้วกด **ส่งไป Datacat** Card Shelf จะคัดลอกลิงก์บอทแล้วพาไปแท็บ Datacat วางลิงก์ Datacat จะสร้างการ์ดและนำเข้าให้ first mes ครบ ลอร์บุ๊คมาด้วย เพราะเป็นระบบนำเข้าของ Datacat เอง Card Shelf ไม่ได้แปลงอะไรเอง

และมีตัวเลือก **หยุด/ซ่อนแมวเต้นของ Datacat** บนแถบด้านบน สำหรับคนที่จอกระตุก

## ต้องมี

- [Datacat SillyTavern Browser](https://github.com/datacat-run/datacat-sillytavern-browser) — แท็บ Datacat คือหน้าต่างของ Datacat ตัวนี้
- **เปิดพร็อกซีของ SillyTavern** สำหรับรายชื่อในแท็บ JanitorAI: เปิดไฟล์ `config.yaml` ในโฟลเดอร์ SillyTavern แก้ `enableCorsProxy: false` เป็น `enableCorsProxy: true` แล้วรีสตาร์ท SillyTavern

JanitorAI ไม่ยอมให้เว็บอื่นแสดงหน้าเว็บของมันในกรอบ และไม่ให้เบราว์เซอร์อ่านข้อมูลตรง ๆ Card Shelf จึงอ่านรายชื่อผ่านพร็อกซีที่มีอยู่ใน SillyTavern แล้ววาดรายชื่อเอง

## ติดตั้ง

ใน SillyTavern เปิด **Extensions → Install extension** แล้ววาง URL นี้:

```
https://github.com/inathael-58/SillyTavern-Card-Shelf
```

## ใช้

1. เปิด Card Shelf จากไอคอนเข็มทิศ 🧭 บนแถบด้านบน เมนูไม้กายสิทธิ์ (Extensions) หรือคำสั่ง `/shelf`
2. แท็บ **JanitorAI** เลือก **Ranking** / **Trending** / **ล่าสุด** หรือค้นหาชื่อบอท เลื่อนลงเพื่อโหลดเพิ่ม
3. แตะบอทที่ชอบ แล้วกด **ส่งไป Datacat**
4. Card Shelf คัดลอกลิงก์ให้แล้วสลับไปแท็บ **Datacat** วางลิงก์ลงในช่องของ Datacat แล้วนำเข้าตามปกติ
5. นำเข้าเสร็จ Datacat เปิดแชทใหม่ให้ Card Shelf ปิดเองให้เห็นแชทเลย (ปิดตัวเลือกนี้ได้ในการตั้งค่า)

ปุ่มอื่นในหน้าบอท: **คัดลอกลิงก์** (เฉย ๆ) และ **เปิดใน JanitorAI** ถ้าคัดลอกอัตโนมัติไม่ได้ จะมีช่องลิงก์ให้กดค้างคัดลอกเอง

สลับแท็บไปมาได้ รายชื่อกับหน้า Datacat อยู่ที่เดิม ไม่โหลดใหม่

คำสั่ง: `/shelf` · `/shelf datacat` · `/shelf janitor` · `/shelf ranking` · `/shelf trending` · `/shelf latest` (`/janitor` ก็ได้)

### ถ้ารายชื่อไม่ขึ้น

แท็บ JanitorAI จะบอกว่าติดอะไรพร้อมวิธีแก้ เช่น พร็อกซียังไม่เปิด หรือ Cloudflare ของ JanitorAI บล็อกเครื่องที่รัน SillyTavern ไปที่ **Extensions → Card Shelf → การเชื่อมต่อ JanitorAI → ทดสอบการเชื่อมต่อ** ได้ ระหว่างนั้นกด **เปิดบนเว็บ JanitorAI** แล้วคัดลอกลิงก์บอทจากเว็บ มาวางในแท็บ Datacat ได้เหมือนกัน

ถ้า JanitorAI เปลี่ยนชื่อการเรียง (sort) ของ Ranking / Trending แก้ได้ในหน้าตั้งค่าเดียวกัน

## แมว Datacat

ใน **Extensions → Card Shelf → แมว Datacat บนแถบด้านบน**:

| ตัวเลือก | |
|---|---|
| เต้นตามปกติ | ไม่ยุ่งกับ Datacat |
| หยุดนิ่ง | เปลี่ยน GIF เป็นรูปนิ่งเฟรมแรก กดเปิด Datacat ได้เหมือนเดิม |
| ซ่อน | ซ่อนปุ่มบนแถบด้านบน เปิด Datacat จาก Card Shelf หรือเมนูไม้กายสิทธิ์ → Explore |

GIF ที่เล่นตลอดทำให้เบราว์เซอร์วาดแถบด้านบนใหม่ทุกเฟรม บางเครื่องรู้สึกกระตุกตอนบอทกำลังพิมพ์ Card Shelf ไม่ลบปุ่มของ Datacat (Datacat จะสร้างใหม่ถ้าหายไป) แค่หยุดภาพหรือซ่อนด้วย CSS

## ทำงานยังไง

- แท็บ Datacat คือหน้าต่างของ Datacat SillyTavern Browser เอง (iframe เดิมของมัน พร้อมระบบนำเข้าของมัน) Card Shelf แค่ขอให้ Datacat เปิดหน้าต่าง แล้วย้ายมาวางในแท็บ ไม่ได้คุยกับ datacat.run เอง
- แท็บ JanitorAI อ่านรายชื่อบอทจาก JanitorAI ผ่านพร็อกซีของ SillyTavern ในเครื่องคุณ ไม่ส่งแชท API key หรือการตั้งค่าใด ๆ ออกไป

## พัฒนา

```bash
npm test
```

## License

GNU Affero General Public License v3.0 ดู [LICENSE](LICENSE)
