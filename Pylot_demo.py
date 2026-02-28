# Code to demonstrate the features of Pylot

# <Shift> + <Enter> executes the smallest possible piece of code
# block that includes the line at the cursor.

print("hello world!")

# The value of a single expression line will be printed
1+2

# The selection doesn't have to cover the whole line.
multiline = """Multi-line commands without
indent can be executed with the cursor
anywhere in the block"""

# An animated line indicates that Python is busy.
import time
for i in 5,4,3,2,1:
    print("Wait", '* '*i)
    time.sleep(1)

if True:
    print('We divide 5 by zero:')
    print('The result is:', 5 / 0)   # --> runtime error

# Multiple interactive plots can be plotted at the same time

import numpy
import matplotlib.pyplot as plt

fig = plt.figure()
x = numpy.linspace(0,10,500)
for i in 1,2,3:
    y = 0.2*numpy.cumsum(numpy.random.randn(500))
    plt.plot(x, y+5*i)
    plt.fill_between(x, y+5*i-0.1*y-1, y+5*i+0.1*y+1, alpha=0.2)
plt.show()

# The next figure can be shown while the first is visible

fig = plt.figure()
n, (r0, r1) = 100, numpy.random.rand(2)
for i in range(n):
    t = numpy.linspace(i,(i+1),250)
    x = (1 - 0.9*t/n) * numpy.cos(1.5*2*numpy.pi*(t+r0))
    y = (1 - 0.9*t/n) * (numpy.sin(3.008*2*numpy.pi*t) + numpy.sin(1.5*numpy.pi*(t+r1)))
    plt.plot(x, y, color=plt.cm.plasma(float(i)/n), alpha=0.9, lw=0.8)
plt.show()

