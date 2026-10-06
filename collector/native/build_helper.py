"""Build the AArch64 JNI dispatcher and Unity main-thread callback with Keystone 0.9.2."""
from pathlib import Path
import json
import struct
from keystone import Ks, KS_ARCH_ARM64, KS_MODE_LITTLE_ENDIAN

root = Path(__file__).resolve().parent
profile = json.loads((root.parent.parent/'config'/'il2cpp-runtime.json').read_text(encoding='utf-8'))
array_data = profile['layout']['array']['data']
if type(array_data) is not int or not 0 <= array_data <= 4095 or array_data % 8:
    raise ValueError('Invalid managed array data offset')
source = (root/'unity_main_invoke.S').read_text(encoding='utf-8')
source = source.replace('MANAGED_ARRAY_DATA_OFFSET', str(array_data))
code = bytes(Ks(KS_ARCH_ARM64, KS_MODE_LITTLE_ENDIAN).asm(source)[0])
call_code=bytes(Ks(KS_ARCH_ARM64, KS_MODE_LITTLE_ENDIAN).asm((root/'jni_dispatch.S').read_text(encoding='utf-8'))[0])
data = bytearray(0x1200 + len(call_code))
identity = b'\x7fELF\x02\x01\x01' + bytes(9)
data[:64] = struct.pack('<16sHHIQQQIHHHHHH', identity, 3, 183, 1, 0, 64, 0x800, 0, 64, 56, 2, 64, 7, 6)
data[64:120] = struct.pack('<IIQQQQQQ', 1, 5, 0, 0, 0, len(data), len(data), 0x1000)
invoke_name = b'D4DJUnityMainInvoke'
dispatch_name = b'D4DJJniDispatch'
soname = b'unity_invoke.so'
invoke_offset = 1
dispatch_offset = invoke_offset + len(invoke_name) + 1
soname_offset = dispatch_offset + len(dispatch_name) + 1
strings = b'\0' + invoke_name + b'\0' + dispatch_name + b'\0' + soname + b'\0'
dynamic = [(5,0x200),(10,len(strings)),(6,0x280),(11,24),(4,0x300),(14,soname_offset),(0,0)]
data[120:176] = struct.pack('<IIQQQQQQ', 2, 4, 0x400, 0x400, 0x400, len(dynamic)*16, len(dynamic)*16, 8)
data[0x200:0x200+len(strings)] = strings
data[0x280+24:0x280+48] = struct.pack('<IBBHQQ',invoke_offset,0x12,0,5,0x1000,len(code))
data[0x280+48:0x280+72] = struct.pack('<IBBHQQ',dispatch_offset,0x12,0,5,0x1200,len(call_code))
data[0x300:0x318] = struct.pack('<6I',1,3,1,0,2,0)
for i, entry in enumerate(dynamic):
    data[0x400+i*16:0x410+i*16] = struct.pack('<QQ',*entry)
data[0x500:0x50c] = b'MWABI001' + struct.pack('<I', array_data)
section_names=b'\0.dynstr\0.dynsym\0.hash\0.dynamic\0.text\0.shstrtab\0'
data[0x600:0x600+len(section_names)]=section_names
sections=[(0,0,0,0,0,0,0,0,0,0),
          (1,3,2,0x200,0x200,len(strings),0,0,1,0),
          (9,11,2,0x280,0x280,72,1,1,8,24),
          (17,5,2,0x300,0x300,24,2,0,4,4),
          (23,6,2,0x400,0x400,len(dynamic)*16,1,0,8,16),
          (32,1,6,0x1000,0x1000,0x200+len(call_code),0,0,4,0),
          (38,3,0,0,0x600,len(section_names),0,0,1,0)]
for i, section in enumerate(sections):
    data[0x800+i*64:0x840+i*64]=struct.pack('<IIQQQQIIQQ',*section)
data[0x1000:0x1000+len(code)] = code
data[0x1200:] = call_code
(root/'unity_invoke.so').write_bytes(data)
print('Built', len(data), 'bytes with', len(code)//4, 'instructions.')
