stp x29, x30, [sp, #-32]!
stp x19, x20, [sp, #16]
mov x29, sp
mov x19, x2
ldr x16, [x19]
ldp x0, x1, [x19, #8]
ldp x2, x3, [x19, #24]
blr x16
str x0, [x19, #40]
ldp x19, x20, [sp, #16]
ldp x29, x30, [sp], #32
ret
