stp x29, x30, [sp, #-32]!
stp x19, x20, [sp, #16]
mov x29, sp
add x19, x0, #32
ldr x1, [x19, #8]
cbnz x1, invoke
ldr x16, [x19, #64]
ldp x0, x1, [x19, #72]
ldr w2, [x19, #88]
blr x16
str x0, [x19, #8]
cbz x0, missing
invoke:
ldr x16, [x19]
ldp x0, x1, [x19, #8]
ldr x2, [x19, #24]
add x3, x19, #40
blr x16
str x0, [x19, #32]
cbz x0, finished
ldr x16, [x19, #48]
mov w1, #0
blr x16
str x0, [x19, #56]
finished:
add x20, x19, #96
mov w0, #1
 b complete
missing:
add x20, x19, #96
mov w0, #2
complete:
stlr w0, [x20]
ldp x19, x20, [sp, #16]
ldp x29, x30, [sp], #32
ret
